/**
 * session の状態 (#127)。ccx が定義し、transcript と一緒に運ぶ (docs/design/scope.md
 * 「Session state is ccx's to hold」)。
 *
 * 2 種類ある。観測 (running / ended / remote) は事実から導き、手では書かない。
 * 宣言 (archived / label / task / heartbeat / metadata) は人か session が書く。archived は
 * Desktop App と同じ語で「一覧から畳む」宣言。「保存先にだけあり手元に無い」観測は remote
 * と呼び、語を分ける。ccx が意味を持つのは top level の鍵だけ。metadata は利用者の語彙
 * (done / pinned 等) を ccx が意味を持たずに運ぶ入れ物 (#165、#135 の「利用者側の marker は
 * 持たない」を置き換えた): ccx は OSS なので、どの marker を持つかを ccx が決めない。
 *
 * 宣言のローカルの置き場所は `~/.claude/sessions/<id>/` (利用者側の script が marker を
 * 置いていた場所と同じ。Claude Code 自身は `<pid>.json` しか置かない)。`archived` は空
 * ファイル、`label` は auto-label hook が置いていたテキストをそのまま読む、`task` は
 * 新しいテキスト。metadata は `meta/<key>` の 1 key 1 ファイル (中身が値、空なら値なし)。
 * shell の読み手 (statusline / hook) が `[ -e … ]` で読めるように、JSON 1 つにはしない。
 * 保存先には `state.json` 1 つにまとめて置く (transcript.ts が push / pull で運ぶ)。
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const claudeHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export const FLAGS = ["archived"] as const;
export type Flag = (typeof FLAGS)[number];

/** 宣言された状態。無いものは false / 空文字 */
export type DeclaredState = {
  archived: boolean;
  label: string;
  task: string;
  /** この session の heartbeat の上書き。空なら ccx-agent の既定に従う (docs/design/heartbeat.md) */
  heartbeat: Heartbeat;
  /** 利用者の key/value。ccx は意味を持たない。値が空文字でも key があれば「立っている」 */
  metadata: Metadata;
};

export type Metadata = Record<string, string>;

/** ファイル名になるので、区切り・`.` 始まり (`..` を含む)・`=` (CLI の `key=value`) を通さない */
export const META_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const isMetaKey = (k: string) => META_KEY.test(k);
const META_DIR = "meta";

/** 渡したものの key が正しい string 値だけを、key 順に並べて返す */
function cleanMetadata(raw: unknown): Metadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Metadata = {};
  for (const [k, v] of Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (isMetaKey(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/** writeDeclared に渡す差分。metadata は key ごとで、null はその key を消す */
export type DeclaredPatch = Partial<Omit<DeclaredState, "metadata">> & { metadata?: Record<string, string | null> };

export const HEARTBEATS = ["on", "off"] as const;
export type Heartbeat = (typeof HEARTBEATS)[number] | "";
const asHeartbeat = (v: unknown): Heartbeat => (HEARTBEATS as readonly unknown[]).includes(v) ? (v as Heartbeat) : "";

export type Lifecycle = "running" | "ended" | "remote" | "unknown";

const FLAG_FILE: Record<Flag, string> = { archived: "archived" };
const TEXT_FILE = { label: "label", task: "task", heartbeat: "heartbeat" } as const;

/**
 * ccx を通して宣言したことがある、の印。空の状態 (全部外した) と「一度も宣言していない」を
 * 分けるためだけに置く。これが無いと、手元で archived を外した session に保存先の古い
 * archived が pull や status で戻ってくる
 */
const DECLARED_FILE = ".ccx-declared";

export const EMPTY_DECLARED: DeclaredState = { archived: false, label: "", task: "", heartbeat: "", metadata: {} };

export const sessionDir = (sessionId: string, home = claudeHome()) => join(home, "sessions", sessionId);

export const isFlag = (s: string): s is Flag => (FLAGS as readonly string[]).includes(s);

export const isEmptyDeclared = (s: DeclaredState) =>
  flagsOf(s).length === 0 && !s.label && !s.task && !s.heartbeat && Object.keys(s.metadata).length === 0;

/** 立っている flag の名前。`ls` の列と JSON の両方で使う */
export const flagsOf = (s: DeclaredState): Flag[] => FLAGS.filter((f) => s[f]);

/** 保存先から来た JSON を、欠けた鍵を埋めて DeclaredState にする */
export function normalizeDeclared(raw: unknown): DeclaredState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    archived: r.archived === true,
    label: typeof r.label === "string" ? r.label : "",
    task: typeof r.task === "string" ? r.task : "",
    heartbeat: asHeartbeat(r.heartbeat),
    metadata: cleanMetadata(r.metadata),
  };
}

const sameMetadata = (a: Metadata, b: Metadata) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
};

export const sameDeclared = (a: DeclaredState, b: DeclaredState) =>
  FLAGS.every((f) => a[f] === b[f]) &&
  a.label === b.label &&
  a.task === b.task &&
  a.heartbeat === b.heartbeat &&
  sameMetadata(a.metadata, b.metadata);

async function readMetadata(dir: string): Promise<Metadata> {
  let names: string[];
  try {
    names = await readdir(join(dir, META_DIR));
  } catch {
    return {};
  }
  const out: Metadata = {};
  for (const k of names.filter(isMetaKey).sort()) {
    try {
      out[k] = (await Bun.file(join(dir, META_DIR, k)).text()).trim();
    } catch {
      // ディレクトリ等、読めないものは key として数えない
    }
  }
  return out;
}

export async function readDeclared(sessionId: string, home = claudeHome()): Promise<DeclaredState> {
  const dir = sessionDir(sessionId, home);
  const flag = (f: Flag) => Bun.file(join(dir, FLAG_FILE[f])).exists();
  const text = async (name: string) => {
    try {
      return (await Bun.file(join(dir, name)).text()).trim();
    } catch {
      return "";
    }
  };
  const [archived, label, task, heartbeat, metadata] = await Promise.all([
    flag("archived"),
    text(TEXT_FILE.label),
    text(TEXT_FILE.task),
    text(TEXT_FILE.heartbeat),
    readMetadata(dir),
  ]);
  return { archived, label, task, heartbeat: asHeartbeat(heartbeat), metadata };
}

/**
 * 差分だけ書く。flag は空ファイルの有無、label / task / heartbeat は中身 (空文字なら消す)。
 * metadata は key ごとに、文字列ならその値で置き (空文字は値なし)、null なら消す。
 * 渡さなかった鍵は触らない
 */
export async function writeDeclared(sessionId: string, patch: DeclaredPatch, home = claudeHome()): Promise<DeclaredState> {
  for (const k of Object.keys(patch.metadata ?? {})) if (!isMetaKey(k)) throw new Error(`invalid metadata key ${JSON.stringify(k)}`);
  const dir = sessionDir(sessionId, home);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, DECLARED_FILE), "");
  for (const f of FLAGS) {
    if (patch[f] === undefined) continue;
    const p = join(dir, FLAG_FILE[f]);
    if (patch[f]) await Bun.write(p, "");
    else await rm(p, { force: true });
  }
  for (const k of ["label", "task", "heartbeat"] as const) {
    if (patch[k] === undefined) continue;
    const p = join(dir, TEXT_FILE[k]);
    if (patch[k]) await Bun.write(p, `${patch[k]}\n`);
    else await rm(p, { force: true });
  }
  for (const [k, v] of Object.entries(patch.metadata ?? {})) {
    const p = join(dir, META_DIR, k);
    if (v === null) await rm(p, { force: true });
    else await Bun.write(p, v ? `${v}\n` : "");
  }
  return readDeclared(sessionId, home);
}

/** 8-4-4-4-12。Claude Code の session id はこの形 (小文字で書かれる) */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * この machine が、その session の宣言状態を持っているか。宣言を 1 度でも書いた (全部
 * 外した後も含む) か、印が 1 つでもある (label は auto-label hook が ccx を通さず書く) とき。
 * 持っているなら、保存先の写しで上書きも補完もしない
 */
export async function holdsDeclared(sessionId: string, home = claudeHome()): Promise<boolean> {
  if (await Bun.file(join(sessionDir(sessionId, home), DECLARED_FILE)).exists()) return true;
  return !isEmptyDeclared(await readDeclared(sessionId, home));
}

/**
 * 印が 1 つでも立っている session の id (transcript の有無は問わない)。ディレクトリが
 * あるだけでは数えない: 印を外した後や、Claude Code 自身が置くファイル (label の履歴
 * 等) で空のディレクトリが残るため
 */
export async function markedSessionIds(home = claudeHome()): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(join(home, "sessions"))).filter((n) => UUID.test(n));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of names) if (!isEmptyDeclared(await readDeclared(id, home))) out.push(id);
  return out;
}

/**
 * 完全な id はそのまま。先頭一致は known の中で一意なときだけ通す。
 * 曖昧なら止まる (別の session に印を付けない)
 */
export function resolveSessionId(idOrPrefix: string, known: Iterable<string>): string {
  // Claude Code の id は小文字。大文字で受けても同じ session を指す (Linux では別のディレクトリになる)
  const q = idOrPrefix.toLowerCase();
  if (UUID.test(q)) return q;
  const hits = [...new Set(known)].filter((id) => id.startsWith(q)).sort();
  if (hits.length === 0) throw new NoLocalSession(idOrPrefix);
  if (hits.length > 1) throw new Error(`${idOrPrefix} matches ${hits.length} sessions: ${hits.join(", ")}`);
  return hits[0]!;
}

export class NoLocalSession extends Error {
  constructor(readonly prefix: string) {
    super(`no local session matches ${prefix}`);
    this.name = "NoLocalSession";
  }
}

