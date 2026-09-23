/**
 * session の状態 (#127)。ccx が定義し、transcript と一緒に運ぶ (docs/design/scope.md
 * 「Session state is ccx's to hold」)。
 *
 * 2 種類ある。観測 (running / ended / remote) は事実から導き、手では書かない。
 * 宣言 (archived / label / task) は人か session が書く。archived は Desktop App と同じ
 * 語で「一覧から畳む」宣言。「保存先にだけあり手元に無い」観測は remote と呼び、語を
 * 分ける。flag が archived だけなのはユーザー判断 (2026-09-21、#135): done は archived
 * とほぼ同じ、pinned は表示だけの利用者固有の都合、ephemeral は意味が立たない。
 * それらは利用者側の marker のまま、ccx は持たない。
 *
 * 宣言のローカルの置き場所は `~/.claude/sessions/<id>/` (利用者側の script が marker を
 * 置いていた場所と同じ。Claude Code 自身は `<pid>.json` しか置かない)。`archived` は空
 * ファイル、`label` は auto-label hook が置いていたテキストをそのまま読む、`task` は
 * 新しいテキスト。保存先には `state.json` 1 つにまとめて置く (transcript.ts が push /
 * pull で運ぶ)。
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
};

export type Lifecycle = "running" | "ended" | "remote" | "unknown";

const FLAG_FILE: Record<Flag, string> = { archived: "archived" };
const TEXT_FILE = { label: "label", task: "task" } as const;

/**
 * ccx を通して宣言したことがある、の印。空の状態 (全部外した) と「一度も宣言していない」を
 * 分けるためだけに置く。これが無いと、手元で archived を外した session に保存先の古い
 * archived が pull や status で戻ってくる
 */
const DECLARED_FILE = ".ccx-declared";

export const EMPTY_DECLARED: DeclaredState = { archived: false, label: "", task: "" };

export const sessionDir = (sessionId: string, home = claudeHome()) => join(home, "sessions", sessionId);

export const isFlag = (s: string): s is Flag => (FLAGS as readonly string[]).includes(s);

export const isEmptyDeclared = (s: DeclaredState) => flagsOf(s).length === 0 && !s.label && !s.task;

/** 立っている flag の名前。`ls` の列と JSON の両方で使う */
export const flagsOf = (s: DeclaredState): Flag[] => FLAGS.filter((f) => s[f]);

/** 保存先から来た JSON を、欠けた鍵を埋めて DeclaredState にする */
export function normalizeDeclared(raw: unknown): DeclaredState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    archived: r.archived === true,
    label: typeof r.label === "string" ? r.label : "",
    task: typeof r.task === "string" ? r.task : "",
  };
}

export const sameDeclared = (a: DeclaredState, b: DeclaredState) =>
  FLAGS.every((f) => a[f] === b[f]) && a.label === b.label && a.task === b.task;

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
  const [archived, label, task] = await Promise.all([flag("archived"), text(TEXT_FILE.label), text(TEXT_FILE.task)]);
  return { archived, label, task };
}

/**
 * 差分だけ書く。flag は空ファイルの有無、label / task は中身 (空文字なら消す)。
 * 渡さなかった鍵は触らない
 */
export async function writeDeclared(sessionId: string, patch: Partial<DeclaredState>, home = claudeHome()): Promise<DeclaredState> {
  const dir = sessionDir(sessionId, home);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, DECLARED_FILE), "");
  for (const f of FLAGS) {
    if (patch[f] === undefined) continue;
    const p = join(dir, FLAG_FILE[f]);
    if (patch[f]) await Bun.write(p, "");
    else await rm(p, { force: true });
  }
  for (const k of ["label", "task"] as const) {
    if (patch[k] === undefined) continue;
    const p = join(dir, TEXT_FILE[k]);
    if (patch[k]) await Bun.write(p, `${patch[k]}\n`);
    else await rm(p, { force: true });
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

