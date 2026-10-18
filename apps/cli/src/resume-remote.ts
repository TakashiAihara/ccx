/**
 * `ccx session resume --machine` の別マシン側 (#261、docs/design/resume.md)。
 *
 * center へ依頼を置き、その session のあるマシンの ccx-agent が取りに行って `ccx session resume
 * <id>` を走らせ、その結果を待つ。center から ccx-agent へは繋がない (resume.proto) なので、
 * 待ち合いは center の依頼の表だけで解決する。表が持つのは「取られたか」「終わったか」「期限を
 * 過ぎたか」の 3 つだけ — どれもこの側が読み返して見るので、決まった値として扱ってよい
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
  requestResume(arg: { key?: SessionKeyLike; force?: boolean; waitSeconds?: number }): Promise<{ request?: ResumeRequest }>;
  listResumeRequests(arg: { machine?: string; user?: string; sessionId?: string }): Promise<{ requests: ResumeRequest[] }>;
};

/**
 * 相手が agent を待つ時間 (`--wait`) に、ccx-agent が取りに来るまでの数秒とその結果を center に
 * 返すまでの時間を足した分。相手の既定 40 秒 + 2 分
 */
export function remoteWaitMs(waitMs: number | undefined): number {
  return (waitMs ?? 40_000) + 120_000;
}

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
  /** 相手の `ccx session resume --wait` に渡す秒数。渡さないなら相手の既定 */
  waitSeconds?: number;
  /** 取りに来て opened になるまで待つ時間 */
  waitMs: number;
  /** 待ち合いの間隔 (既定 2 秒) */
  pollMs?: number;
}): Promise<ResumeRequest> {
  const pollMs = o.pollMs ?? 2_000;
  const { machine, user, sessionId } = o.key;

  const placed = await o.center.requestResume({
    key: o.key,
    force: Boolean(o.force),
    ...(o.waitSeconds ? { waitSeconds: o.waitSeconds } : {}),
  });
  const id = placed.request?.id;
  if (!id) throw new ResumeError("the center did not return the resume request it was asked to keep", 1);

  const deadline = Date.now() + o.waitMs;
  let latest: ResumeRequest | undefined;
  let unread: Error | undefined;
  for (;;) {
    let requests: ResumeRequest[];
    try {
      ({ requests } = await o.center.listResumeRequests({ machine, user, sessionId }));
      unread = undefined;
    } catch (e) {
      // 待ちのあいだの読み直しが 1 回失敗しても、その瞬間には何も決まっていない。次の
      // poll で読めれば足りる。締め切りまで読めなかった場合だけ、この理由を出して終わる
      unread = e instanceof Error ? e : new Error(String(e));
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
      continue;
    }
    latest = requests.find((r) => r.id === id);
    // 一覧に無いのは「まだ終わっていない」ではない。自分で置いた依頼を追えないので、追跡自体を諦める
    if (!latest) throw new ResumeError(`the center's resume requests hold no ${id}`, 1);
    // 期限を過ぎた依頼は agent が取らない。もう一度置けば開く
    if (latest.expired) {
      throw new ResumeError(
        latest.claimedAt
          ? `the request ${id} on ${machine} expired: a ccx-agent took it but did not answer within its run limit, so whether it opened is not known; put it again to try once more (a session already open there is refused as running)`
          : `the request ${id} on ${machine} expired: it was not taken in time and will not be opened; put it again to try once more`,
        5,
      );
    }
    if (latest.finishedAt) {
      if (latest.outcome === ResumeOutcome.OPENED) return latest;
      // 相手の `ccx session resume` の exit code をそのまま出す。1 と 4 以外は分けない意味が無いので 1 にする
      const code = latest.exitCode === 1 || latest.exitCode === 4 ? latest.exitCode : 1;
      throw new ResumeError(`${machine} did not open it (exit ${latest.exitCode}): ${latest.detail}`, code);
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  // 締め切りまで一度も読めなかった、または最後の読みが失敗した。追跡できたかも分かないので、
  // 返事が無いことに尽きる
  if (unread) {
    throw new ResumeError(
      `the resume requests for ${machine} could not be read within ${o.waitMs} ms, so nothing is known about ${id}: ${unread.message}`,
      5,
    );
  }
  // 期限切れ。誰も取りに来ていないのと、取って応答が無いのは直す先が違うので分けて言う
  throw new ResumeError(
    latest?.claimedAt
      ? `the request ${id} on ${machine} was taken but has not answered within ${o.waitMs} ms`
      : `no ccx-agent on ${machine} has taken it after ${o.waitMs} ms; it stays on the center until it expires (10 minutes after it was placed), and is opened if that machine's ccx-agent takes it before then`,
    5,
  );
}