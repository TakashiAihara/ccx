/**
 * repodir のメタデータ。2 ファイルに分ける。
 *
 *   .git/ccx.json   生成時に確定する不変の事実。ccx repodir new のみが書く
 *   .git/ccx.state  可変のライフサイクル。ccx / ccxd が書く
 *
 * .git/ 配下に置くのは (a) git status に出ない、(b) agent が誤ってコミットする
 * ことが原理的に不可能、(c) dir と生死を共にし孤児が残らない、の 3 点による。
 *
 * 導出できるものは持たない。host / owner / repo は path から、created は dir-id から、
 * branch / dirty / 未 push は git から、session は Claude のプロジェクトディレクトリから
 * 導出できるので、ここには書かない (created だけは可読性のため明示的に持つ)。
 */

import { join } from "node:path";

export const META_SCHEMA = 1;

export type Goal = {
  issue?: string;
  clickup?: string;
};

export type PrIntent = {
  /** Issue を立てない repodir 用。Issue があれば Issue 側から導出できる */
  milestone?: string;
  reviewers?: string[];
};

export type RepodirMeta = {
  schema: number;
  /** 生成時に与えたタスク。「いま何をしているか」ではなく「何のために生まれたか」 */
  initialTask?: string;
  goal?: Goal;
  pr?: PrIntent;
  /** rd open のデフォルト。claude / opencode / cursor 等 */
  agent: string;
  model?: string;
  /** どこから生えたか。後から確実に復元できない */
  baseBranch: string;
  baseCommit: string;
  created: string;
  /** "user" または "session:<id>" */
  createdBy: string;
  ccxVersion: string;
};

export type DesiredState = "running" | "stopped";

export type RepodirState = {
  desired: DesiredState;
  done: { at: string; by: string } | null;
};

export const metaPath = (dir: string) => join(dir, ".git", "ccx.json");
export const statePath = (dir: string) => join(dir, ".git", "ccx.state");

export async function writeMeta(dir: string, meta: RepodirMeta): Promise<void> {
  await Bun.write(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function readMeta(dir: string): Promise<RepodirMeta | null> {
  const f = Bun.file(metaPath(dir));
  if (!(await f.exists())) return null;
  return (await f.json()) as RepodirMeta;
}

export async function writeState(dir: string, state: RepodirState): Promise<void> {
  await Bun.write(statePath(dir), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readState(dir: string): Promise<RepodirState | null> {
  const f = Bun.file(statePath(dir));
  if (!(await f.exists())) return null;
  return (await f.json()) as RepodirState;
}

/**
 * createdBy を決める。Claude Code の session 内から呼ばれていればその session を、
 * そうでなければ "user" を返す。系譜は後から復元できないのでここで確定させる。
 */
export function detectCreatedBy(env: Record<string, string | undefined> = process.env): string {
  const id = env.CLAUDE_SESSION_ID;
  return id ? `session:${id}` : "user";
}
