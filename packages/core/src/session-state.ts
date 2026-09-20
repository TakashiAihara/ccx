/**
 * session の状態 (#127)。ccx が定義し、transcript と一緒に運ぶ (docs/design/scope.md
 * 「Session state is ccx's to hold」)。
 *
 * 2 種類ある。観測 (running / ended / archived) は事実から導き、手では書かない。
 * 宣言 (done / pinned / ephemeral / label / task) は人か session が書く。
 *
 * 宣言のローカルの置き場所は `~/.claude/sessions/<id>/` で、ファイル名は利用者側の
 * script が以前から使っていたものをそのまま採る (`done` / `pinned` / `delete` の空
 * ファイル、`label` のテキスト)。statusline / SessionEnd hook / idle reaper がその名前を
 * 読んでいるので、ccx が書いた印を今日から読める。`task` だけが新しい。
 *
 * ephemeral のファイルだけ名前が `delete` なのは、SessionEnd hook がその名前で
 * 「終了時に transcript を消す」を判定しているため。CLI と state.json では ephemeral。
 *
 * 保存先には `state.json` 1 つにまとめて置く (transcript.ts が push / pull で運ぶ)。
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const claudeHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export const FLAGS = ["done", "pinned", "ephemeral"] as const;
export type Flag = (typeof FLAGS)[number];

/** 宣言された状態。無いものは false / 空文字 */
export type DeclaredState = {
  done: boolean;
  pinned: boolean;
  ephemeral: boolean;
  label: string;
  task: string;
};

export type Lifecycle = "running" | "ended" | "archived" | "unknown";

const FLAG_FILE: Record<Flag, string> = { done: "done", pinned: "pinned", ephemeral: "delete" };
const TEXT_FILE = { label: "label", task: "task" } as const;

export const EMPTY_DECLARED: DeclaredState = { done: false, pinned: false, ephemeral: false, label: "", task: "" };

export const sessionDir = (sessionId: string, home = claudeHome()) => join(home, "sessions", sessionId);

export const isFlag = (s: string): s is Flag => (FLAGS as readonly string[]).includes(s);

export const isEmptyDeclared = (s: DeclaredState) => !s.done && !s.pinned && !s.ephemeral && !s.label && !s.task;

/** 立っている flag の名前。`ls` の列と JSON の両方で使う */
export const flagsOf = (s: DeclaredState): Flag[] => FLAGS.filter((f) => s[f]);

/** 保存先から来た JSON を、欠けた鍵を埋めて DeclaredState にする */
export function normalizeDeclared(raw: unknown): DeclaredState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    done: r.done === true,
    pinned: r.pinned === true,
    ephemeral: r.ephemeral === true,
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
  const [done, pinned, ephemeral, label, task] = await Promise.all([
    flag("done"),
    flag("pinned"),
    flag("ephemeral"),
    text(TEXT_FILE.label),
    text(TEXT_FILE.task),
  ]);
  return { done, pinned, ephemeral, label, task };
}

/**
 * 差分だけ書く。flag は空ファイルの有無、label / task は中身 (空文字なら消す)。
 * 渡さなかった鍵は触らない
 */
export async function writeDeclared(sessionId: string, patch: Partial<DeclaredState>, home = claudeHome()): Promise<DeclaredState> {
  const dir = sessionDir(sessionId, home);
  await mkdir(dir, { recursive: true });
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 印のディレクトリを持つ session の id (transcript の有無は問わない) */
export async function markedSessionIds(home = claudeHome()): Promise<string[]> {
  try {
    return (await readdir(join(home, "sessions"))).filter((n) => UUID.test(n));
  } catch {
    return [];
  }
}

/**
 * 完全な id はそのまま。先頭一致は known の中で一意なときだけ通す。
 * 曖昧なら止まる (別の session に印を付けない)
 */
export function resolveSessionId(idOrPrefix: string, known: Iterable<string>): string {
  if (UUID.test(idOrPrefix)) return idOrPrefix;
  const hits = [...new Set(known)].filter((id) => id.startsWith(idOrPrefix)).sort();
  if (hits.length === 0) throw new Error(`no local session matches ${idOrPrefix}`);
  if (hits.length > 1) throw new Error(`${idOrPrefix} matches ${hits.length} sessions: ${hits.join(", ")}`);
  return hits[0]!;
}

