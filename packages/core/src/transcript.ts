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
 *                                                            /history/<ms>-<op>-<machine>.json  push / pull / prune の履歴
 *
 * transcript.jsonl は変換しない。Claude Code が `--resume` で読むのはこのファイルその
 * もので、置き直した先で byte が違えば会話が壊れる。
 *
 * 履歴 (history/) は上書きせず 1 操作 1 オブジェクトで足す。「いつどのマシンで
 * resume されたか」は必須の記録で、同じ会話を別のマシンで別のタスクに使う運用が
 * あるため、二重の pull を拒む lease は持たない。
 */

import { readdir, stat, unlink, rm, mkdir } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";

import { encodeCwd } from "./scan.ts";

export type TranscriptStore = {
  /** S3 互換の endpoint。ccx-center なら hub.url と同じ */
  endpoint: string;
  bucket: string;
  /** key の前に付ける。空か、`/` で終わる文字列 */
  prefix: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type Origin = { machine: string; user: string };

export type LocalTranscript = {
  sessionId: string;
  path: string;
  /** ~/.claude/projects/<encoded cwd> */
  projectDir: string;
  size: number;
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
  toolResults: string[];
};

export type HistoryEntry = {
  op: "push" | "pull" | "prune";
  machine: string;
  user: string;
  at: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const claudeHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export const localOrigin = (): Origin => ({ machine: hostname(), user: userInfo().username });

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
      out.push({ sessionId, path, projectDir, size: s.size, mtime: s.mtime, toolResultsDir: hasTr ? tr : null });
    }
  }
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/**
 * 今動いている session の id。Claude Code が ~/.claude/sessions/<pid>.json に
 * 自分の pid と sessionId を書くので、pid が生きているものだけを数える。
 * pid は巡回するので、ファイルがあるだけでは生きている証拠にならない。
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
      const j = (await Bun.file(join(dir, n)).json()) as { pid?: number; sessionId?: string };
      if (!j.pid || !j.sessionId) continue;
      process.kill(j.pid, 0);
      ids.add(j.sessionId);
    } catch {
      /* 読めない / 死んでいる */
    }
  }
  return ids;
}

/** transcript の先頭から cwd / gitBranch / version を持つ最初のレコードを拾う */
export async function transcriptFacts(path: string): Promise<Pick<SessionMeta, "cwd" | "gitBranch" | "version">> {
  const facts = { cwd: "", gitBranch: "", version: "" };
  const text = await Bun.file(path).text();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!facts.cwd && typeof r.cwd === "string") facts.cwd = r.cwd;
    if (!facts.gitBranch && typeof r.gitBranch === "string") facts.gitBranch = r.gitBranch;
    if (!facts.version && typeof r.version === "string") facts.version = r.version;
    if (facts.cwd && facts.gitBranch && facts.version) break;
  }
  return facts;
}

export async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

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

export type PushResult = { status: "pushed" | "unchanged"; meta: SessionMeta };
export type PullResult = { status: "pulled" | "already-here"; meta: SessionMeta; path: string };
export type PruneResult = { status: "pruned" | "refused"; reason?: string; meta: SessionMeta | null };

export class TranscriptClient {
  readonly s3: Bun.S3Client;

  constructor(
    readonly store: TranscriptStore,
    readonly origin: Origin = localOrigin(),
    s3?: Bun.S3Client,
  ) {
    // 資格情報は S3 クライアントの標準の env (AWS_ACCESS_KEY_ID 等) から。無ければ
    // center 向けのダミー。center は署名を見ないので値は何でもよい
    s3 ??= new Bun.S3Client({
      endpoint: store.endpoint,
      bucket: store.bucket,
      region: store.region ?? "us-east-1",
      accessKeyId: store.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID ?? "ccx",
      secretAccessKey:
        store.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY ?? "ccx",
    });
    this.s3 = s3;
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

  /** 保存先にある session を全部。session.json を 1 つずつ読む (件数が効くまで index は持たない) */
  async list(): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    for (const m of await this.children(this.root())) {
      for (const u of await this.children(`${this.root()}${m}/`)) {
        for (const s of await this.children(`${this.root()}${m}/${u}/`)) {
          const key = `${this.root()}${m}/${u}/${s}/session.json`;
          try {
            metas.push((await this.s3.file(key).json()) as SessionMeta);
          } catch {
            /* 置きかけ (transcript はあるが session.json がまだ無い) は一覧に出さない */
          }
        }
      }
    }
    return metas.sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1));
  }

  /** どのマシンの下にあっても session id で見つける */
  async find(sessionId: string): Promise<SessionMeta | null> {
    for (const m of await this.children(this.root())) {
      for (const u of await this.children(`${this.root()}${m}/`)) {
        const key = `${this.root()}${m}/${u}/session_id=${sessionId}/session.json`;
        if (await this.s3.exists(key)) return (await this.s3.file(key).json()) as SessionMeta;
      }
    }
    return null;
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
    return out.sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  private async record(prefix: string, op: HistoryEntry["op"]): Promise<void> {
    const at = new Date().toISOString();
    const e: HistoryEntry = { op, machine: this.origin.machine, user: this.origin.user, at };
    await this.s3.write(`${prefix}history/${Date.now()}-${op}-${this.origin.machine}.json`, JSON.stringify(e));
  }

  /**
   * 置く。同じ内容 (sha256 が一致) なら何も書かない。
   * 順序は transcript → tool-results → session.json で、session.json が最後。
   * 途中で落ちれば session.json が古いままなので、次の push が同じ判定で書き直す。
   */
  async push(t: LocalTranscript): Promise<PushResult> {
    const prefix = this.keyPrefix(t.sessionId);
    const [digest, facts] = await Promise.all([sha256(t.path), transcriptFacts(t.path)]);
    const size = (await stat(t.path)).size;

    const metaKey = `${prefix}session.json`;
    if (await this.s3.exists(metaKey)) {
      const prev = (await this.s3.file(metaKey).json()) as SessionMeta;
      if (prev.sha256 === digest && prev.size === size) return { status: "unchanged", meta: prev };
    }

    await this.s3.write(`${prefix}transcript.jsonl`, Bun.file(t.path));

    const toolResults: string[] = [];
    if (t.toolResultsDir) {
      for (const n of (await readdir(t.toolResultsDir)).sort()) {
        await this.s3.write(`${prefix}tool-results/${n}`, Bun.file(join(t.toolResultsDir, n)));
        toolResults.push(n);
      }
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
    };
    await this.s3.write(metaKey, JSON.stringify(meta, null, 2));
    await this.record(prefix, "push");
    return { status: "pushed", meta };
  }

  /**
   * 取り出して `claude --resume <id>` が見つける場所に置く。置き場所は元の cwd の
   * encoded dir。そのパスがこのマシンに無くても Claude Code は id で引く (#110)。
   * 手元に同じ id の別内容があれば、上書きせず止まる (force で越える)。
   */
  async pull(sessionId: string, home = claudeHome(), force = false): Promise<PullResult> {
    const meta = await this.find(sessionId);
    if (!meta) throw new Error(`session ${sessionId} is not in the store`);
    const prefix = this.keyPrefix(sessionId, meta);

    const projectDir = join(home, "projects", encodeCwd(meta.cwd));
    const path = join(projectDir, `${sessionId}.jsonl`);
    if (await Bun.file(path).exists()) {
      if ((await sha256(path)) === meta.sha256) return { status: "already-here", meta, path };
      if (!force) {
        throw new Error(
          `${path} exists with different content than the store's copy (local ${await sha256(path)}, store ${meta.sha256}); pass --force to overwrite`,
        );
      }
    }

    await mkdir(projectDir, { recursive: true });
    const tmp = `${path}.pull-tmp`;
    await Bun.write(tmp, this.s3.file(`${prefix}transcript.jsonl`));
    if ((await sha256(tmp)) !== meta.sha256) {
      await unlink(tmp);
      throw new Error(`downloaded transcript for ${sessionId} does not match session.json sha256; not installed`);
    }
    await Bun.write(path, Bun.file(tmp));
    await unlink(tmp);

    if (meta.toolResults.length) {
      const trDir = join(projectDir, sessionId, "tool-results");
      await mkdir(trDir, { recursive: true });
      for (const n of meta.toolResults) {
        await Bun.write(join(trDir, basename(n)), this.s3.file(`${prefix}tool-results/${n}`));
      }
    }
    await this.record(prefix, "pull");
    return { status: "pulled", meta, path };
  }

  /**
   * ローカルの写しを消す。消してよいのは、保存先の写しが今のローカルと byte 一致
   * すると読み戻せたときだけ。動いている session は消さない。
   */
  async prune(t: LocalTranscript, running: Set<string>): Promise<PruneResult> {
    if (running.has(t.sessionId)) return { status: "refused", reason: "session is running", meta: null };
    const prefix = this.keyPrefix(t.sessionId);
    const metaKey = `${prefix}session.json`;
    if (!(await this.s3.exists(metaKey))) return { status: "refused", reason: "not in the store (push first)", meta: null };
    const meta = (await this.s3.file(metaKey).json()) as SessionMeta;

    // 保存先の写しを読み戻してハッシュを取る。session.json の値ではなく実体で比べる。
    // 置いた後に保存先側で壊れていれば、ここで違う値が出る
    const h = new Bun.CryptoHasher("sha256");
    for await (const chunk of this.s3.file(`${prefix}transcript.jsonl`).stream()) h.update(chunk);
    const remoteDigest = h.digest("hex");
    const localDigest = await sha256(t.path);
    if (remoteDigest !== localDigest || meta.sha256 !== localDigest) {
      return { status: "refused", reason: "store copy differs from local (push again)", meta };
    }
    for (const n of meta.toolResults) {
      if (!(await this.s3.exists(`${prefix}tool-results/${n}`))) {
        return { status: "refused", reason: `store is missing tool-results/${n} (push again)`, meta };
      }
    }

    await unlink(t.path);
    if (t.toolResultsDir) await rm(join(t.projectDir, t.sessionId), { recursive: true, force: true });
    await this.record(prefix, "prune");
    return { status: "pruned", meta };
  }
}
