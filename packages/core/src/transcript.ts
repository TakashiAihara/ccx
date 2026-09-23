/**
 * session の transcript を S3 互換の保存先に置き、別マシンで取り出す (#121)。
 *
 * 保存先は S3 の API を話すものなら何でもよい。既定は ccx-center の object API
 * (apps/hub/src/objects.ts) だが、利用者が自分の bucket を指してもコードは変わらない。
 *
 * レイアウトは Hive 形式 (`key=value` のディレクトリ) で、DuckDB が manifest 無しに
 * machine / user / session_id を列として読める:
 *
 *   <prefix>transcripts/machine=<m>/user=<u>/session_id=<id>/transcript.jsonl   ローカルと byte 同一
 *                                                            /tool-results/<name>  JSONL が参照する退避ファイル
 *                                                            /session.json         cwd / branch / version / size / sha256
 *                                                            /state.json           宣言された状態 (archived / label / task。session-state.ts)
 *                                                            /history/<ms>-<op>-<machine>.json  push / pull / prune の履歴
 *
 * transcript.jsonl は変換しない。Claude Code が `--resume` で読むのはこのファイルその
 * もので、置き直した先で byte が違えば会話が壊れる。
 *
 * 履歴 (history/) は上書きせず 1 操作 1 オブジェクトで足す。「いつどのマシンで
 * resume されたか」は必須の記録で、同じ会話を別のマシンで別のタスクに使う運用が
 * あるため、二重の pull を拒む lease は持たない。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";

import { parseRepoSpec } from "./repospec.ts";
import { encodeCwd } from "./scan.ts";
import { claudeHome, holdsDeclared, isEmptyDeclared, normalizeDeclared, readDeclared, sameDeclared, UUID, writeDeclared, type DeclaredState } from "./session-state.ts";

export type TranscriptStore = {
  /** S3 互換の endpoint。ccx-center なら hub.url と同じ */
  endpoint: string;
  bucket: string;
  /** key の前に付ける。空か、`/` で終わる文字列 */
  prefix: string;
  region?: string;
};

export type Origin = { machine: string; user: string };

export type LocalTranscript = {
  sessionId: string;
  path: string;
  /** ~/.claude/projects/<encoded cwd> */
  projectDir: string;
  mtime: Date;
  /** <projectDir>/<sessionId>/tool-results。無ければ null */
  toolResultsDir: string | null;
};

/** session.json。保存先に置いた時点の事実 */
export type SessionMeta = {
  sessionId: string;
  machine: string;
  user: string;
  cwd: string;
  gitBranch: string;
  /** Claude Code のバージョン (transcript の各レコードが持つ) */
  version: string;
  size: number;
  sha256: string;
  pushedAt: string;
  toolResults: ToolResult[];
  /**
   * cwd の git remote (origin) から取った `host/owner/repo`。pull した側がここから
   * repodir を作る。cwd が git の外なら無い
   */
  repo?: string;
};

export type ToolResult = { name: string; sha256: string };

/** cwd の origin を `host/owner/repo` に。git の外 / origin 無し / cwd が無い、は undefined */
export async function repoOf(cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined;
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0 || !out.trim()) return undefined;
    const s = parseRepoSpec(out.trim(), { defaultHost: "github.com" });
    return `${s.host}/${s.owner}/${s.repo}`;
  } catch {
    return undefined;
  }
}

export type HistoryEntry = {
  /** `state` は state.json だけを書いた (transcript は同じ) */
  op: "push" | "pull" | "prune" | "state";
  machine: string;
  user: string;
  at: string;
};

/** machine は config の `machine` (ccx-agent と同じ規則) を渡す。省けば hostname */
export const localOrigin = (machine = hostname()): Origin => ({ machine, user: userInfo().username });

/** ~/.claude/projects 配下の <uuid>.jsonl を全部。cwd の別を問わない (session id が鍵) */
export async function localTranscripts(home = claudeHome()): Promise<LocalTranscript[]> {
  const projects = join(home, "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return [];
  }
  const out: LocalTranscript[] = [];
  for (const d of dirs) {
    const projectDir = join(projects, d);
    let names: string[];
    try {
      names = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const sessionId = n.slice(0, -".jsonl".length);
      if (!UUID.test(sessionId)) continue;
      const path = join(projectDir, n);
      const s = await stat(path);
      const tr = join(projectDir, sessionId, "tool-results");
      const hasTr = await stat(tr).then((x) => x.isDirectory()).catch(() => false);
      out.push({ sessionId, path, projectDir, mtime: s.mtime, toolResultsDir: hasTr ? tr : null });
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/**
 * pid がその session のプロセスとして生きているか。
 *
 * `kill(pid, 0)` は「その番号のプロセスがある」しか言わず、pid は巡回する。Claude Code は
 * sessions/<pid>.json に `procStart` (Linux の /proc/<pid>/stat 22 番目、起動時刻の tick)
 * を書くので、/proc があればそれと突き合わせる。EPERM は「ある (他人のもの)」で、
 * 死んでいるのは ESRCH だけ
 */
async function pidAlive(pid: number, procStart: string | undefined): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (!procStart) return true;
  try {
    const statLine = await Bun.file(`/proc/${pid}/stat`).text();
    // comm に空白が入りうるので、`)` の後ろから数える。starttime は `)` 以降の 20 番目
    const after = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
    return after[19] === procStart;
  } catch {
    // /proc が無い (macOS) — kill の答えで判定する
    return true;
  }
}

/**
 * 今動いている session の id。Claude Code が ~/.claude/sessions/<pid>.json に
 * 自分の pid と sessionId を書くので、そのプロセスが生きているものだけを数える。
 */
export async function runningSessionIds(home = claudeHome()): Promise<Set<string>> {
  const dir = join(home, "sessions");
  const ids = new Set<string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return ids;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const j = (await Bun.file(join(dir, n)).json()) as { pid?: number; sessionId?: string; procStart?: string };
      if (!j.pid || !j.sessionId) continue;
      if (await pidAlive(j.pid, j.procStart)) ids.add(j.sessionId);
    } catch {
      /* 読めない */
    }
  }
  return ids;
}

/**
 * transcript の先頭から cwd / gitBranch / version を持つ最初のレコードを拾う。
 * 行ごとに読み、全部見ても揃わなければ (git の外で走った session に gitBranch は
 * 無い) 上限で止める。ファイル全体をメモリに載せない
 */
export async function transcriptFacts(
  path: string,
  maxLines = 500,
): Promise<Pick<SessionMeta, "cwd" | "gitBranch" | "version">> {
  const facts = { cwd: "", gitBranch: "", version: "" };
  const decoder = new TextDecoder();
  let rest = "";
  let seen = 0;
  outer: for await (const chunk of Bun.file(path).stream()) {
    rest += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (!line) continue;
      seen += 1;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (!facts.cwd && typeof r.cwd === "string") facts.cwd = r.cwd;
        if (!facts.gitBranch && typeof r.gitBranch === "string") facts.gitBranch = r.gitBranch;
        if (!facts.version && typeof r.version === "string") facts.version = r.version;
      } catch {
        /* 書きかけの行 */
      }
      if ((facts.cwd && facts.gitBranch && facts.version) || seen >= maxLines) break outer;
    }
  }
  return facts;
}

export async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** ローカルの tool-results の名前と sha256。無ければ空 */
async function localToolResults(dir: string | null): Promise<ToolResult[]> {
  if (!dir) return [];
  const out: ToolResult[] = [];
  for (const name of (await readdir(dir)).sort()) out.push({ name, sha256: await sha256(join(dir, name)) });
  return out;
}

const sameToolResults = (a: ToolResult[], b: ToolResult[]) =>
  a.length === b.length && a.every((x, i) => x.name === b[i]!.name && x.sha256 === b[i]!.sha256);

const byString = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export class NoTranscriptStore extends Error {
  constructor() {
    super(
      [
        "no transcript store configured — nowhere to push to or pull from.",
        "",
        "Point ccx at a center (its object API is the default store):",
        "  CCX_HUB_URL=http://host:8791",
        "or at any S3-compatible endpoint:",
        "  CCX_TRANSCRIPT_ENDPOINT=https://s3.example  CCX_TRANSCRIPT_BUCKET=ccx",
        "  ~/.config/ccx/config.toml   [transcript] endpoint = \"...\"  bucket = \"ccx\"",
      ].join("\n"),
    );
    this.name = "NoTranscriptStore";
  }
}

/**
 * 資格情報は S3 クライアントの標準の env (AWS_* / S3_*) から。無ければ center 向けの
 * ダミー。center は署名を見ないので値は何でもよい
 */
function makeS3(store: TranscriptStore): Bun.S3Client {
  const env = process.env;
  return new Bun.S3Client({
    endpoint: store.endpoint,
    bucket: store.bucket,
    region: store.region ?? "us-east-1",
    // 外部の S3 に資格情報無しで行けば、そちらが AccessDenied で名指しする
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID ?? "ccx",
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY ?? "ccx",
  });
}

/** 単独で意味を持つ 8 文字以上の先頭一致を、保存先の session id に解く */
export class AmbiguousSessionId extends Error {
  constructor(prefix: string, readonly matches: string[]) {
    super(`${prefix} matches ${matches.length} sessions: ${matches.join(", ")}`);
    this.name = "AmbiguousSessionId";
  }
}

/** `state` は state.json だけが変わった (transcript は同じ) */
export type PushResult = { status: "pushed" | "state" | "unchanged"; meta: SessionMeta; state: DeclaredState };
export type PullResult = {
  status: "pulled" | "already-here";
  meta: SessionMeta;
  /** 保存先の state.json。無ければ null (state.json より前に push されたもの) */
  state: DeclaredState | null;
  /** state を手元の印に写したか。手元に印が既にあれば写さない */
  stateApplied: boolean;
  path: string;
  /** --force で押し退けた元のファイルの退避先 */
  replaced?: string;
};
export type PruneResult = { status: "pruned" | "refused"; reason?: string; meta: SessionMeta | null };

export class TranscriptClient {
  readonly s3: Bun.S3Client;

  constructor(
    readonly store: TranscriptStore,
    readonly origin: Origin = localOrigin(),
    s3?: Bun.S3Client,
  ) {
    this.s3 = s3 ?? makeS3(store);
  }

  private root(): string {
    return `${this.store.prefix}transcripts/`;
  }

  /** そのマシン・ユーザーの session の key prefix */
  keyPrefix(sessionId: string, origin: Origin = this.origin): string {
    return `${this.root()}machine=${origin.machine}/user=${origin.user}/session_id=${sessionId}/`;
  }

  /** delimiter 付きの一覧で 1 段だけ降りる。返るのは `<prefix><name>/` の name */
  private async children(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.list({ prefix, delimiter: "/", continuationToken: token });
      for (const p of page.commonPrefixes ?? []) out.push(p.prefix.slice(prefix.length, -1));
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    return out;
  }

  private async readMeta(key: string): Promise<SessionMeta | null> {
    try {
      return (await this.s3.file(key).json()) as SessionMeta;
    } catch {
      // 置きかけ (transcript はあるが session.json がまだ無い) は無いものとして扱う
      return null;
    }
  }

  /**
   * 保存先の state.json。無ければ null (「無い」と「全部 false」を混ぜない)。null を返すのは
   * 無いと確かめられたときだけで、保存先が答えない / 読めない JSON は投げる — 握りつぶすと
   * push が「保存先は空」と読んで手元の解除を送らず、unchanged と報告する
   */
  async readRemoteDeclared(sessionId: string, origin: Origin = this.origin): Promise<DeclaredState | null> {
    const f = this.s3.file(`${this.keyPrefix(sessionId, origin)}state.json`);
    if (!(await f.exists())) return null;
    return normalizeDeclared(await f.json());
  }

  /**
   * 保存先のその origin の下に session.json があるか。1 HEAD で済むので `session ls` の remote
   * 判定に使う (`find` は全 machine を list する)。保存先が答えなければ投げる (「無い」にしない)
   */
  async inStore(sessionId: string, origin: Origin = this.origin): Promise<boolean> {
    return this.s3.file(`${this.keyPrefix(sessionId, origin)}session.json`).exists();
  }

  /**
   * 保存先にある session を全部 (machine を渡せばその下だけ、prefix で絞る)。
   * session.json を 1 つずつ読む: 一覧 3 段 + session 数の GET。件数が効くまで
   * index は持たない (ファイルが真実源)
   */
  async list(machine?: string): Promise<SessionMeta[]> {
    const machines = machine ? [`machine=${machine}`] : await this.children(this.root());
    const keys: string[] = [];
    for (const m of machines) {
      for (const u of await this.children(`${this.root()}${m}/`)) {
        for (const s of await this.children(`${this.root()}${m}/${u}/`)) keys.push(`${this.root()}${m}/${u}/${s}/session.json`);
      }
    }
    const metas = (await Promise.all(keys.map((k) => this.readMeta(k)))).filter((m): m is SessionMeta => m !== null);
    return metas.sort((a, b) => byString(b.pushedAt, a.pushedAt));
  }

  /** 同じ id の写しを全部 (別マシンから push されたものを含む)。新しい push が先 */
  async findAll(sessionId: string): Promise<SessionMeta[]> {
    const out: SessionMeta[] = [];
    for (const m of await this.children(this.root())) {
      for (const u of await this.children(`${this.root()}${m}/`)) {
        const meta = await this.readMeta(`${this.root()}${m}/${u}/session_id=${sessionId}/session.json`);
        if (meta) out.push(meta);
      }
    }
    return out.sort((a, b) => byString(b.pushedAt, a.pushedAt));
  }

  /** どのマシンの下にあっても session id で見つける。複数あれば最後に push されたもの */
  async find(sessionId: string): Promise<SessionMeta | null> {
    return (await this.findAll(sessionId))[0] ?? null;
  }

  /**
   * `ls` が出す短い id (先頭一致) を保存先の完全な id にする。完全な id はそのまま。
   * 一意でなければ AmbiguousSessionId、無ければ null
   */
  async resolve(idOrPrefix: string): Promise<string | null> {
    if (UUID.test(idOrPrefix)) return idOrPrefix;
    const ids = new Set<string>();
    for (const m of await this.children(this.root())) {
      for (const u of await this.children(`${this.root()}${m}/`)) {
        for (const s of await this.children(`${this.root()}${m}/${u}/`)) {
          const id = s.replace(/^session_id=/, "");
          if (id.startsWith(idOrPrefix)) ids.add(id);
        }
      }
    }
    if (ids.size > 1) throw new AmbiguousSessionId(idOrPrefix, [...ids].sort());
    return [...ids][0] ?? null;
  }

  async history(meta: SessionMeta): Promise<HistoryEntry[]> {
    const prefix = `${this.keyPrefix(meta.sessionId, meta)}history/`;
    const out: HistoryEntry[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.list({ prefix, continuationToken: token });
      for (const o of page.contents ?? []) out.push((await this.s3.file(o.key).json()) as HistoryEntry);
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => byString(a.at, b.at));
  }

  private async record(prefix: string, op: HistoryEntry["op"]): Promise<void> {
    const now = new Date();
    const e: HistoryEntry = { op, machine: this.origin.machine, user: this.origin.user, at: now.toISOString() };
    // key は時刻順に並び、同じ ms に 2 回書いても上書きしない
    const key = `${prefix}history/${now.getTime()}-${op}-${this.origin.machine}-${randomUUID().slice(0, 8)}.json`;
    await this.s3.write(key, JSON.stringify(e));
  }

  /** 保存先の object を読み戻して sha256 を取る。session.json の値ではなく実体で比べるため */
  private async remoteSha256(key: string): Promise<string | null> {
    if (!(await this.s3.exists(key))) return null;
    const h = new Bun.CryptoHasher("sha256");
    for await (const chunk of this.s3.file(key).stream()) h.update(chunk);
    return h.digest("hex");
  }

  /**
   * 置く。同じ内容 (transcript の sha256 と tool-results の名前と sha256 が一致) なら
   * 何も書かない。動いている session でも push できるが、ハッシュと転送は同じ
   * スナップショットから取る (追記の途中で読むと session.json と実体がずれる)。
   * 順序は transcript → tool-results → session.json で、session.json が最後。
   * 途中で落ちれば session.json が古いままなので、次の push が同じ判定で書き直す。
   * state.json は transcript と独立に、ローカルの印と違うときだけ書く (印は transcript
   * が変わらなくても変わる)。
   */
  async push(t: LocalTranscript, home = claudeHome()): Promise<PushResult> {
    const prefix = this.keyPrefix(t.sessionId);
    const snapshot = `${t.path}.push-tmp`;
    const state = await readDeclared(t.sessionId, home);
    const syncState = async () => {
      const remote = await this.readRemoteDeclared(t.sessionId);
      if (remote && sameDeclared(remote, state)) return false;
      // 印が 1 つも無い session に空の state.json を置かない。無いのは空と同じ意味で、
      // 印を付けたことのない session ごとに PUT が 1 つ増えるだけになる
      if (!remote && isEmptyDeclared(state)) return false;
      await this.s3.write(`${prefix}state.json`, JSON.stringify(state, null, 2));
      return true;
    };
    try {
      await Bun.write(snapshot, Bun.file(t.path));
      const [digest, facts, toolResults] = await Promise.all([
        sha256(snapshot),
        transcriptFacts(snapshot),
        localToolResults(t.toolResultsDir),
      ]);
      const repo = await repoOf(facts.cwd);
      const size = (await stat(snapshot)).size;

      const metaKey = `${prefix}session.json`;
      const prev = await this.readMeta(metaKey);
      if (prev && prev.sha256 === digest && prev.size === size && sameToolResults(prev.toolResults, toolResults)) {
        if (!(await syncState())) return { status: "unchanged", meta: prev, state };
        // transcript は運んでいないが、印が変わったことは履歴に残す (いつ・どのマシンが)
        await this.record(prefix, "state");
        return { status: "state", meta: prev, state };
      }

      await this.s3.write(`${prefix}transcript.jsonl`, Bun.file(snapshot));
      // tool-results は 1 度置いたら変わらない (名前と sha256 が前回と同じなら送らない)
      const already = new Map((prev?.toolResults ?? []).map((r) => [r.name, r.sha256]));
      for (const r of toolResults) {
        if (already.get(r.name) === r.sha256) continue;
        await this.s3.write(`${prefix}tool-results/${r.name}`, Bun.file(join(t.toolResultsDir!, r.name)));
      }

      const meta: SessionMeta = {
        sessionId: t.sessionId,
        machine: this.origin.machine,
        user: this.origin.user,
        ...facts,
        size,
        sha256: digest,
        pushedAt: new Date().toISOString(),
        toolResults,
        ...(repo ? { repo } : {}),
      };
      await this.s3.write(metaKey, JSON.stringify(meta, null, 2));
      await syncState();
      await this.record(prefix, "push");
      return { status: "pushed", meta, state };
    } finally {
      await rm(snapshot, { force: true });
    }
  }

  /**
   * 取り出して `claude --resume <id>` が見つける場所に置く。置き場所は元の cwd の
   * encoded dir。そのパスがこのマシンに無くても Claude Code は id で引く (#110)。
   * tool-results を先に置き、transcript は最後に rename で現れる。途中で落ちても
   * transcript が無いので次の pull がやり直す。手元に同じ id の別内容があれば、
   * 上書きせず止まる。force で越えるときも、元のファイルは隣に退避して消さない
   * (push されていない続きかもしれない)。
   * 保存先の state.json は、この machine がその session の宣言を持っていないときだけ写す
   * (holdsDeclared)。持っていれば (印を付けた / 全部外した / transcript より先に付けた)
   * 触らない — 手元の宣言を古い写しで上書きも復活もさせない。already-here でも同じ判定で
   * 写すので、前の pull が印を写す前に落ちていても、pull をやり直せば直る。
   */
  async pull(sessionId: string, home = claudeHome(), force = false): Promise<PullResult> {
    const meta = await this.find(sessionId);
    if (!meta) throw new Error(`session ${sessionId} is not in the store`);
    const prefix = this.keyPrefix(sessionId, meta);
    const state = await this.readRemoteDeclared(sessionId, meta);

    const projectDir = join(home, "projects", encodeCwd(meta.cwd || "unknown"));
    const path = join(projectDir, `${sessionId}.jsonl`);
    const trDir = join(projectDir, sessionId, "tool-results");

    let replaced: string | undefined;
    if (await Bun.file(path).exists()) {
      const localDigest = await sha256(path);
      if (localDigest === meta.sha256) {
        // transcript は同じ。tool-results まで揃っていれば何もしない
        const hasTr = (await stat(trDir).catch(() => null))?.isDirectory() ?? false;
        if (sameToolResults(await localToolResults(hasTr ? trDir : null), meta.toolResults)) {
          // transcript は揃っている。前の pull が印を写す前に落ちていたら、ここで写し直す
          return { status: "already-here", meta, state, stateApplied: await this.applyState(sessionId, state, home), path };
        }
      } else if (!force) {
        throw new Error(
          `${path} exists with different content than the store's copy (local ${localDigest}, store ${meta.sha256}); pass --force to overwrite (the local file is kept next to it as .replaced-<time>)`,
        );
      } else {
        replaced = `${path}.replaced-${Date.now()}`;
      }
    }

    await mkdir(projectDir, { recursive: true });
    if (meta.toolResults.length) await mkdir(trDir, { recursive: true });
    for (const r of meta.toolResults) {
      const dest = join(trDir, basename(r.name));
      await Bun.write(dest, this.s3.file(`${prefix}tool-results/${r.name}`));
      if ((await sha256(dest)) !== r.sha256) {
        await rm(dest, { force: true });
        throw new Error(`downloaded tool-results/${r.name} for ${sessionId} does not match session.json; not installed`);
      }
    }

    const tmp = `${path}.pull-tmp`;
    try {
      await Bun.write(tmp, this.s3.file(`${prefix}transcript.jsonl`));
      if ((await sha256(tmp)) !== meta.sha256) {
        throw new Error(`downloaded transcript for ${sessionId} does not match session.json sha256; not installed`);
      }
      if (replaced) await rename(path, replaced);
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
    const stateApplied = await this.applyState(sessionId, state, home);
    await this.record(prefix, "pull");
    return { status: "pulled", meta, state, stateApplied, path, replaced };
  }

  private async applyState(sessionId: string, state: DeclaredState | null, home: string): Promise<boolean> {
    if (!state || (await holdsDeclared(sessionId, home))) return false;
    await writeDeclared(sessionId, state, home);
    return true;
  }

  /**
   * ローカルの写しを消す。消してよいのは、保存先のどれかの写し (どのマシンが push
   * したものでもよい) が transcript も tool-results も今のローカルと byte 一致すると
   * 読み戻せたときだけ。動いている session は消さない。消すのは transcript と
   * tool-results だけで、<projectDir>/<id>/ に他のものがあれば残す。
   */
  async prune(t: LocalTranscript, running: Set<string>): Promise<PruneResult> {
    if (running.has(t.sessionId)) return { status: "refused", reason: "session is running", meta: null };
    const copies = await this.findAll(t.sessionId);
    if (copies.length === 0) return { status: "refused", reason: "not in the store (push first)", meta: null };

    const localDigest = await sha256(t.path);
    const localTr = await localToolResults(t.toolResultsDir);
    const candidates = copies.filter((m) => m.sha256 === localDigest && sameToolResults(m.toolResults, localTr));
    if (candidates.length === 0) {
      return { status: "refused", reason: "no copy in the store matches the local files (push again)", meta: copies[0]! };
    }

    let verified: SessionMeta | null = null;
    for (const meta of candidates) {
      const prefix = this.keyPrefix(t.sessionId, meta);
      if ((await this.remoteSha256(`${prefix}transcript.jsonl`)) !== localDigest) continue;
      let ok = true;
      for (const r of meta.toolResults) {
        if ((await this.remoteSha256(`${prefix}tool-results/${r.name}`)) !== r.sha256) {
          ok = false;
          break;
        }
      }
      if (ok) {
        verified = meta;
        break;
      }
    }
    if (!verified) {
      return { status: "refused", reason: "the store's copy does not read back identical (push again)", meta: candidates[0]! };
    }

    await unlink(t.path);
    if (t.toolResultsDir) {
      await rm(t.toolResultsDir, { recursive: true, force: true });
      // tool-results しか無かったなら親も畳む。他に何かあれば触らない
      await rmdir(join(t.projectDir, t.sessionId)).catch(() => undefined);
    }
    await this.record(this.keyPrefix(t.sessionId, verified), "prune");
    return { status: "pruned", meta: verified };
  }
}
