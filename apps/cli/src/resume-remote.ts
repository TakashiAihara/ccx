/**
 * `ccx session resume --machine` の別マシン側 (#261、docs/design/resume.md)。
 *
 * center へ依頼を置き、その session のあるマシンの ccx-agent が取りに行って `ccx session resume
 * <id>` を走らせ、その結果を待つ。center から ccx-agent へは繋がない (resume.proto) ので、
 * 待ち合いは center の依頼の表だけで解決する。表が持つのは「取られたか」と「終わったか」の
 * 2 つだけ — どちらもこの側が読み返して見るので、決まった値として扱ってよい
 *
 * ここで言えるのは「開いた / 開けなかった / 返ってこなかった」だけ。どの session を開くかは
 * 依頼を置いた人が決めていて、ccx-agent も判断しない (docs/design/scope.md)。
 */

import { ResumeOutcome, type ResumeRequest } from "@ccx/proto/ccx/v1/resume_pb.ts";

import { ResumeError, sleep } from "./resume.ts";

/** center に渡す session の鍵。proto の生成物を組み立てず、素の 3 つだけを持つ */
export type SessionKeyLike = { machine: string; user: string; sessionId: string };

/**
 * center との話し方。必要な 2 つだけを形にしてあるので、ResumeService の client をそのまま
 * 渡せる (接続の組み立てはこのファイルの外: fleet.ts の transport)
 */
export type ResumeCenter = {
  requestResume(arg: { key?: SessionKeyLike; force?: boolean }): Promise<{ request?: ResumeRequest }>;
  listResumeRequests(arg: { machine?: string; user?: string; sessionId?: string }): Promise<{ requests: ResumeRequest[] }>;
};

/**
 * 依頼を置き、それが終わるまで読んで、開けたら開いた依頼を返す。
 *
 * 追跡は center が振った依頼の id だけで行う。id を返さない answer は追えないのでそこで止める:
 * 「まだ」に読ませて先へ進むと、進んだ分だけ後で説明しきれなくなる
 */
export async function resumeRemote(o: {
  center: ResumeCenter;
  /** 開く session と、その session がある場所 */
  key: SessionKeyLike;
  /** archived でも開く (`ccx session resume --force`) */
  force?: boolean;
  /** 取りに来て opened になるまで待つ時間 */
  waitMs: number;
  /** 待ち合いの間隔 (既定 2 秒) */
  pollMs?: number;
}): Promise<ResumeRequest> {
  const pollMs = o.pollMs ?? 2_000;
  const { machine, user, sessionId } = o.key;

  const placed = await o.center.requestResume({ key: o.key, force: Boolean(o.force) });
  const id = placed.request?.id;
  if (!id) throw new ResumeError("the center did not return the resume request it was asked to keep", 1);

  const deadline = Date.now() + o.waitMs;
  let latest: ResumeRequest | undefined;
  for (;;) {
    const { requests } = await o.center.listResumeRequests({ machine, user, sessionId });
    latest = requests.find((r) => r.id === id);
    // 一覧に無いのは「まだ終わっていない」ではない。自分で置いた依頼を追えないので、追跡自体を諦める
    if (!latest) throw new ResumeError(`the center's resume requests hold no ${id}`, 1);
    if (latest.finishedAt) {
      if (latest.outcome === ResumeOutcome.OPENED) return latest;
      // 相手の `ccx session resume` の exit code をそのまま出す。1 と 4 以外は分けない意味が無いので 1 にする
      const code = latest.exitCode === 1 || latest.exitCode === 4 ? latest.exitCode : 1;
      throw new ResumeError(`${machine} did not open it (exit ${latest.exitCode}): ${latest.detail}`, code);
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  // 期限切れ。誰も取りに来ていないのと、取って応答が無いのは直す先が違うので分けて言う
  throw new ResumeError(
    latest?.claimedAt
      ? `the request ${id} on ${machine} was taken but has not answered within ${o.waitMs} ms`
      : `no ccx-agent on ${machine} has taken it after ${o.waitMs} ms; it stays on the center and is opened when that machine's ccx-agent comes up`,
    5,
  );
}