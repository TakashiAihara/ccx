/**
 * 回収 (gc)。
 *
 * repodir が 55 個溜まったのは、命名が悪かったからではなく、消す仕組みが無かったから。
 * だから gc は後付けの便利機能ではなく、この層の中核。
 *
 * 安全側の原則: 「消してよい」と「終わった」は別。作業が失われうる状態なら、何が
 * 終わったと言っていようが消さない。
 *
 * 回収の対象は repodir だけではない。ccx 以前の連番 clone (~/.ghq/.../vault2 ...) は
 * 移行しない — session 履歴が cwd をキーに索引されており、動かせば履歴が孤児になる。
 * 代わりに、同じ安全弁の下で自然減させる。そのために gc は repodir root 以外の
 * ディレクトリツリーも走査できる (scanTree)。
 */

import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { git } from "./git.ts";
import { readMeta, readState, type RepodirMeta, type RepodirState } from "./meta.ts";
import { parseRepoSpec, type RepoSpec } from "./repospec.ts";
import {
  claudeProjectDir,
  SESSION_IDLE_MS,
  type GitState,
  type RepodirInfo,
  type SessionState,
} from "./scan.ts";

/**
 * gc が見るもの。repodir (ccx が作った) と foreign dir (旧 clone) の両方。
 *
 * RepodirInfo をそのまま広げているので、scanRepodirs の結果はそのまま渡せる。
 * foreign dir でしか判らない危険 (登録済み worktree 等) は extraBlockers に載る。
 */
export type ScannedDir = RepodirInfo & {
  /** ccx が作っていない dir か。ccx.json も dir-id も無い */
  foreign?: boolean;
  /** foreign dir の走査でのみ検出できる追加の blocker */
  extraBlockers?: string[];
};

/**
 * path そのものが危険なら、その理由。
 *
 * foreign tree を消せるようにするということは、rm の対象が ccx の管理外に出るという
 * こと。root の指定を 1 つ間違えれば home ごと消える。深さと既知の危険 path で弾く。
 */
export function unsafePath(path: string): string | null {
  const p = resolve(path);

  if (p === sep) return "refusing to touch the filesystem root";
  if (p === resolve(homedir())) return "refusing to touch the home directory";

  const depth = p.split(sep).filter(Boolean).length;
  if (depth < 3) return `path is too shallow to be a repository (${p})`;

  return null;
}

/**
 * 走査 root として危険なら、その理由。rm の対象そのものより判定は緩い — root は
 * 消さないので、深さは要らない。防ぎたいのは「/ や home を丸ごと舐める」ことだけ。
 */
export function unsafeRoot(path: string): string | null {
  const p = resolve(path);

  if (p === sep) return "refusing to scan the filesystem root";
  if (p === resolve(homedir())) return "refusing to scan the home directory";

  const depth = p.split(sep).filter(Boolean).length;
  if (depth < 2) return `too broad to scan (${p})`;

  return null;
}

/** 削除してはいけない理由。空なら削除して安全。 */
export function blockers(info: ScannedDir): string[] {
  const out: string[] = [];

  const unsafe = unsafePath(info.path);
  if (unsafe) out.push(unsafe);

  if (info.session.active) out.push("a session is active");
  if (info.git.dirty) out.push("the working tree is dirty");
  if (info.git.unpushed === null) out.push("cannot determine whether commits are pushed");
  else if (info.git.unpushed > 0) out.push(`${info.git.unpushed} unpushed commit(s)`);
  if (info.git.stashes > 0) out.push(`${info.git.stashes} stash(es)`);

  out.push(...(info.extraBlockers ?? []));

  return out;
}

export const isSafeToRemove = (info: ScannedDir) => blockers(info).length === 0;

/**
 * 「終わった」と言えるか。安全性とは独立の軸。
 *
 * done マーカーは AI agent の宣言であって許可ではない。終わったと言っていても、
 * 未 push commit があれば blockers が止める。
 */
export type Finished =
  | { finished: true; reason: string }
  | { finished: false; reason: null };

export function finishedByMarker(info: ScannedDir): Finished {
  const done = info.state?.done;
  return done ? { finished: true, reason: `marked done by ${done.by}` } : { finished: false, reason: null };
}

/**
 * goal (Issue / PR) の状態から終了を判定する。gh に委譲する。
 * gh が無い / 認証されていない場合は「判定できない」として false を返す。
 */
export async function finishedByGoal(info: ScannedDir): Promise<Finished> {
  const issue = info.meta?.goal?.issue;
  if (issue) {
    const state = await ghJson(["issue", "view", issue, "--json", "state", "--jq", ".state"]);
    if (state === "CLOSED") return { finished: true, reason: `${issue} is closed` };
  }

  // PR は保存していない。ブランチから引く。ccx.json の有無は問わない: 旧 clone には
  // goal が無く、「この dir は終わったか」を外から知る手段がブランチしかないため。
  if (info.git.branch) {
    const { host, owner, repo } = info.spec;
    if (host === "github.com") {
      const state = await ghJson([
        "pr", "list",
        "--repo", `${owner}/${repo}`,
        "--head", info.git.branch,
        "--state", "merged",
        "--json", "number",
        "--jq", ".[0].number // empty",
      ]);
      if (state) return { finished: true, reason: `PR #${state} is merged` };
    }
  }

  return { finished: false, reason: null };
}

async function ghJson(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() || null : null;
  } catch {
    return null;
  }
}

export type Candidate = {
  info: ScannedDir;
  blockers: string[];
  finished: string | null;
};

export type PlanOptions = {
  /** 「終わった」と判定できるものだけを対象にする */
  finishedOnly?: boolean;
  /** これより新しい repodir は対象にしない (ミリ秒) */
  minAgeMs?: number;
  /** goal (Issue / PR) の状態を gh に問い合わせる */
  checkGoal?: boolean;
};

export type Plan = {
  remove: Candidate[];
  keep: Candidate[];
};

export async function plan(infos: ScannedDir[], opts: PlanOptions = {}): Promise<Plan> {
  const remove: Candidate[] = [];
  const keep: Candidate[] = [];

  for (const info of infos) {
    const b = blockers(info);

    let f = finishedByMarker(info);
    if (!f.finished && opts.checkGoal) f = await finishedByGoal(info);

    const c: Candidate = { info, blockers: b, finished: f.reason };

    const tooYoung =
      opts.minAgeMs !== undefined && Date.now() - info.created.getTime() < opts.minAgeMs;

    if (b.length > 0 || tooYoung || (opts.finishedOnly && !f.finished)) {
      if (tooYoung) c.blockers = [...b, "younger than the minimum age"];
      if (opts.finishedOnly && !f.finished && b.length === 0 && !tooYoung) {
        c.blockers = ["not finished"];
      }
      keep.push(c);
    } else {
      remove.push(c);
    }
  }

  return { remove, keep };
}

/**
 * 実際に削除する。plan を通していない info は受け付けない設計にはしていないので、
 * 呼ぶ側が plan().remove だけを渡すこと。念のためここでも blockers を再評価する。
 */
export async function reclaim(candidates: Candidate[]): Promise<string[]> {
  const removed: string[] = [];

  for (const c of candidates) {
    // 二重チェック。plan から実行までの間に session が立ち上がっている可能性がある。
    if (blockers(c.info).length > 0) continue;
    await rm(c.info.path, { recursive: true, force: true });
    removed.push(c.info.path);
  }

  return removed;
}

// ---------------------------------------------------------------------------
// foreign tree の走査
//
// ccx 以前の clone は <root>/<host>/<owner>/<repo> (ghq のレイアウト) に居り、
// dir-id も ccx.json も無い。だからここでは構造を前提にせず、「.git を持つ dir」を
// 探して RepodirInfo に読み替える。
//
// git / session の導出は scan.ts と同じ形だが、意図的に別実装にしてある。
// 未 push の数え方が違う: repodir は自分の 1 ブランチしか持たないので現在のブランチを
// 見れば足りるが、旧 clone は何年ぶんものローカルブランチを抱えている。そこでこちらは
// 「どのリモートからも到達できない commit」をローカルブランチ全体で数える。
// 少なく見積もって消すより、多く見積もって残すほうが安い。
// ---------------------------------------------------------------------------

export type TreeScanOptions = {
  /** path に含まれる文字列で絞る */
  filter?: string;
  /** 失っても構うと人間が名指しした ignored path (例: ".serena/") */
  allowIgnored?: string[];
  /** session が生きているとみなす最終更新からの時間 (ミリ秒) */
  idleMs?: number;
  /** root から何階層まで潜って .git を探すか */
  maxDepth?: number;
  /** remote から repo を特定できなかったときに使う host */
  defaultHost?: string;
};

const DEFAULT_MAX_DEPTH = 4;

/**
 * root 配下の git working tree をすべて読む。repodir の 4 階層構造も ccx.json も
 * 前提にしない。repo を 1 つ見つけたらその中には潜らない (submodule を別個の回収対象に
 * しないため)。
 */
export async function scanTree(root: string, opts: TreeScanOptions = {}): Promise<ScannedDir[]> {
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const defaultHost = opts.defaultHost ?? "github.com";
  const allowIgnored = opts.allowIgnored ?? [];

  const paths: string[] = [];
  await walk(resolve(root), 0, maxDepth, paths);

  const hits = opts.filter ? paths.filter((p) => p.includes(opts.filter!)) : paths;
  const all = await Promise.all(
    hits.map((p) => readForeign(p, idleMs, defaultHost, allowIgnored)),
  );

  return all.sort((a, b) => a.created.getTime() - b.created.getTime());
}

async function walk(dir: string, depth: number, maxDepth: number, out: string[]): Promise<void> {
  if (await isGitWorkTree(dir)) {
    out.push(dir);
    return;
  }
  if (depth >= maxDepth) return;

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => walk(join(dir, e.name), depth + 1, maxDepth, out)),
  );
}

/** .git があれば working tree。file の場合 (submodule / worktree) も含む。 */
async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function readForeign(
  path: string,
  idleMs: number,
  defaultHost: string,
  allowIgnored: string[],
): Promise<ScannedDir> {
  const [g, s, spec, extra, created, meta, state] = await Promise.all([
    foreignGitState(path),
    foreignSessionState(path, idleMs),
    foreignSpec(path, defaultHost),
    foreignExtraBlockers(path, allowIgnored),
    createdAt(path),
    readMeta(path).catch((): RepodirMeta | null => null),
    readState(path).catch((): RepodirState | null => null),
  ]);

  return {
    path,
    // 旧 clone に dir-id は無い。表示上の識別子として dir 名が代わりを務める。
    dirId: basename(path),
    spec,
    created,
    meta,
    state,
    metaError: null,
    git: g,
    session: s,
    foreign: true,
    extraBlockers: extra,
  };
}

async function foreignGitState(path: string): Promise<GitState> {
  const [branch, status, stash] = await Promise.all([
    git(["branch", "--show-current"], path).catch(() => ""),
    git(["status", "--porcelain"], path).catch(() => ""),
    // %gd で reflog selector (stash@{0}) だけを出させる。行数を数えるので、git が
    // 空のときに人間向けの文言を足しても誤検出しない。
    git(["stash", "list", "--format=%gd"], path).catch(() => ""),
  ]);

  let hasUpstream = false;
  try {
    await git(["rev-parse", "--abbrev-ref", "@{upstream}"], path);
    hasUpstream = true;
  } catch {
    hasUpstream = false;
  }

  let unpushed: number | null = null;
  try {
    // ローカルの全ブランチ + HEAD (detached 対応) のうち、どのリモートにも無い commit。
    // remote が 1 つも無ければ全 commit が数えられ、結果として必ず blocker になる。
    const [branches, head] = await Promise.all([
      git(["rev-list", "--count", "--branches", "--not", "--remotes"], path),
      git(["rev-list", "--count", "HEAD", "--not", "--remotes"], path),
    ]);
    unpushed = Math.max(Number(branches), Number(head));
    if (!Number.isFinite(unpushed)) unpushed = null;
  } catch {
    // commit が 1 つも無い / git が読めない。判らないなら消さない。
    unpushed = null;
  }

  return {
    branch: branch || null,
    dirty: status.trim() !== "",
    unpushed,
    hasUpstream,
    stashes: stash.split("\n").filter((l) => l.startsWith("stash@{")).length,
  };
}

async function foreignSessionState(path: string, idleMs: number): Promise<SessionState> {
  const dir = claudeProjectDir(path);

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { active: false, lastActivity: null, transcripts: 0 };
  }

  let last: Date | null = null;
  for (const n of names) {
    const { mtime } = await stat(join(dir, n));
    if (!last || mtime > last) last = mtime;
  }

  return {
    active: last !== null && Date.now() - last.getTime() < idleMs,
    lastActivity: last,
    transcripts: names.length,
  };
}

/**
 * foreign dir でだけ起きうる危険。repodir は ccx が作った使い捨てなので該当しない。
 *
 * repodir と foreign dir の決定的な違いは、誰が作ったか。repodir の中身は ccx が
 * mirror から復元できるものしか無い。foreign dir は人間と他のツールが何年もかけて
 * 育てたもので、git が知らない実体を抱えている。
 */
async function foreignExtraBlockers(path: string, allowIgnored: string[]): Promise<string[]> {
  const out: string[] = [];

  try {
    const list = await git(["worktree", "list", "--porcelain"], path);
    // 自分自身が 1 件目。2 件目以降は、この dir を消すと壊れる別の working tree。
    const n = list.split("\n").filter((l) => l.startsWith("worktree ")).length - 1;
    if (n > 0) out.push(`${n} registered worktree(s)`);
  } catch {
    // worktree を列挙できない = git が読めない。unpushed 側が null になって止まる。
  }

  const ignored = await ignoredPaths(path);
  const kept = ignored.filter((p) => !allowIgnored.includes(p));
  if (kept.length > 0) {
    const shown = kept.slice(0, 3).join(", ");
    const rest = kept.length > 3 ? `, +${kept.length - 3} more` : "";
    out.push(`${kept.length} ignored path(s) that git cannot restore (${shown}${rest})`);
  }

  return out;
}

/**
 * git status は ignored を見ない。つまり dirty でも未 push でもない repo に、git の
 * どこにも存在しない実体 (.env / 認証情報 / ローカル設定) が残りうる。「git 的に失う
 * ものが無い」と「実際に失うものが無い」は違う。消したら二度と戻らない。
 *
 * ただし ignored には、失うと困るもの (.env) と、ツールが再生成するだけのもの
 * (.serena/ , node_modules/) が混ざる。実測では旧 clone 55 個のうち 50 個が .serena/
 * だけを抱えており、素朴に「ignored があれば止める」とすると回収が成立しない。
 * かといって「キャッシュらしき名前」を ccx が推測して捨てるのは、捨てる側の推測で
 * 消すということ。だから既定は止める側に倒し、捨ててよい path は allowIgnored で
 * 名指しさせる。何を捨てるかは、いつでも人間が名指しする。
 */
async function ignoredPaths(path: string): Promise<string[]> {
  try {
    const st = await git(["status", "--porcelain", "--ignored"], path);
    return st
      .split("\n")
      .filter((l) => l.startsWith("!! "))
      .map((l) => l.slice(3).trim());
  } catch {
    // git が読めない。unpushed 側が null になって止まる。
    return [];
  }
}

async function foreignSpec(path: string, defaultHost: string): Promise<RepoSpec> {
  try {
    // get-url ではなく生の設定値。get-url は insteadOf の書き換えを適用してしまい、
    // 「どこの repo か」ではなく「どこから取るか」を返す。
    const url = await git(["config", "--get", "remote.origin.url"], path);
    if (url) return parseRepoSpec(url, { defaultHost });
  } catch {
    // remote が無い / 解釈できない URL。path から埋める
  }

  const parts = resolve(path).split(sep).filter(Boolean);
  return {
    host: defaultHost,
    owner: parts.at(-2) ?? "-",
    repo: parts.at(-1) ?? basename(path),
  };
}

/** 旧 clone に created は書かれていない。dir の生成時刻で代用する。 */
async function createdAt(path: string): Promise<Date> {
  try {
    const st = await stat(path);
    const birth = st.birthtime.getTime();
    return new Date(birth > 0 ? birth : st.mtime.getTime());
  } catch {
    return new Date(0);
  }
}
