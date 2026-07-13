/**
 * 回収 (gc)。
 *
 * repodir が 55 個溜まったのは、命名が悪かったからではなく、消す仕組みが無かったから。
 * だから gc は後付けの便利機能ではなく、この層の中核。
 *
 * 安全側の原則: 「消してよい」と「終わった」は別。作業が失われうる状態なら、何が
 * 終わったと言っていようが消さない。
 */

import { rm } from "node:fs/promises";

import type { RepodirInfo } from "./scan.ts";

/** 削除してはいけない理由。空なら削除して安全。 */
export function blockers(info: RepodirInfo): string[] {
  const out: string[] = [];

  if (info.session.active) out.push("a session is active");
  if (info.git.dirty) out.push("the working tree is dirty");
  if (info.git.unpushed === null) out.push("cannot determine whether commits are pushed");
  else if (info.git.unpushed > 0) out.push(`${info.git.unpushed} unpushed commit(s)`);
  if (info.git.stashes > 0) out.push(`${info.git.stashes} stash(es)`);

  return out;
}

export const isSafeToRemove = (info: RepodirInfo) => blockers(info).length === 0;

/**
 * 「終わった」と言えるか。安全性とは独立の軸。
 *
 * done マーカーは AI agent の宣言であって許可ではない。終わったと言っていても、
 * 未 push commit があれば blockers が止める。
 */
export type Finished =
  | { finished: true; reason: string }
  | { finished: false; reason: null };

export function finishedByMarker(info: RepodirInfo): Finished {
  const done = info.state?.done;
  return done ? { finished: true, reason: `marked done by ${done.by}` } : { finished: false, reason: null };
}

/**
 * goal (Issue / PR) の状態から終了を判定する。gh に委譲する。
 * gh が無い / 認証されていない場合は「判定できない」として false を返す。
 */
export async function finishedByGoal(info: RepodirInfo): Promise<Finished> {
  const issue = info.meta?.goal?.issue;
  if (issue) {
    const state = await ghJson(["issue", "view", issue, "--json", "state", "--jq", ".state"]);
    if (state === "CLOSED") return { finished: true, reason: `${issue} is closed` };
  }

  // PR は保存していない。ブランチから引く。
  if (info.git.branch && info.meta) {
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
  info: RepodirInfo;
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

export async function plan(infos: RepodirInfo[], opts: PlanOptions = {}): Promise<Plan> {
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
