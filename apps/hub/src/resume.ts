import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { and, asc, desc, eq, gt, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "./db/open.ts";
import { resumeRequests } from "./db/schema.ts";
import { ResumeOutcome, ResumeService, type ResumeRequest } from "@ccx/proto/ccx/v1/resume_pb.ts";

/**
 * resume.proto の実装 (#261)。人が依頼を置き、その session のあるマシンの ccx-agent が
 * 取りに行って、開いた結果を返す。
 *
 * center から ccx-agent へは繋がない。待ち合いはこの表の中だけで解決する: 誰が取ったかは
 * claimed_at、終わったかは finished_at。
 */

/** listResumeRequests の既定と上限 (resume.proto)。0 は「指定なし」なので既定に落ちる */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** 8-4-4-4-12。大文字で来ても同じ値として扱う */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 取ったまま結果が返らない依頼 (ccx-agent が途中で落ちた) を、Claim で再び取れるまでの
 * 時間。これを越えると「その agent は動いていない」とみなす。放置すると依頼が止まる。
 */
export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 依頼の期限。終わらないままこれを過ぎた依頼は agent が取らず、同じ session に新しい
 * 依頼を置ける。期限が無いと、置きっぱなしの一件がその後の依頼を塞ぎ続け、相手のマシンが
 * 何日も後に上がった時点で開かれる
 */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * detail が持つ上限 (resume.proto)。何が起きたかは末尾にあるので、古いところから切る。
 * 数えるのは Unicode のコードポイント: 折り返すのは文字で、バイトの途中ではない
 */
export const DETAIL_CAP = 4096;

const invalid = (why: string): ConnectError => new ConnectError(why, Code.InvalidArgument);

function clampLimit(v: number): number {
  if (!v) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

/** NOT NULL の行をそのまま proto の依頼に写す。時刻の NULL は「その段階に居ない」 */
function toRequest(r: typeof resumeRequests.$inferSelect, nowMs: number): ResumeRequest {
  return {
    $typeName: "ccx.v1.ResumeRequest",
    id: r.id,
    key: { $typeName: "ccx.v1.SessionKey", machine: r.machine, user: r.user, sessionId: r.sessionId },
    force: r.force,
    requestedAt: timestampFromMs(r.requestedAtMs),
    claimedAt: r.claimedAtMs === null ? undefined : timestampFromMs(r.claimedAtMs),
    finishedAt: r.finishedAtMs === null ? undefined : timestampFromMs(r.finishedAtMs),
    outcome: r.outcome as ResumeOutcome,
    detail: r.detail,
    exitCode: r.exitCode,
    claimToken: r.claimToken,
    // 期限は保存しない。置いた時刻と「今の時計」から読み手ごとに計算する
    expired: r.finishedAtMs === null && r.requestedAtMs <= nowMs - REQUEST_TTL_MS,
    waitSeconds: r.waitSeconds,
  };
}

/** 詳細が上限を超えたら末尾だけを残す。文字の途中で切らない */
function capDetail(detail: string): string {
  const points = [...detail];
  return points.length > DETAIL_CAP ? points.slice(points.length - DETAIL_CAP).join("") : detail;
}

export function resumeImpl(db: Db, now: () => number): ServiceImpl<typeof ResumeService> {
  return {
    requestResume(req) {
      const key = req.key;
      if (!key?.machine || !key.user) throw invalid("key.machine and key.user are required");
      // Claude Code の id は小文字。大文字で置かれた依頼を別の session として持たない
      const sessionId = key.sessionId.toLowerCase();
      if (!SESSION_ID.test(sessionId)) {
        throw invalid(`key.session_id is not a session id: ${key.sessionId}`);
      }
      const nowMs = now();

      // 探して作るまでを 1 トランザクションにする。別のプロセスが同じ DB を開いている
      // ときにも、読んでから書くまでのあいだに割り込まれないようにする (immediate は
      // 書き込む前に write ロックを取る)。同じ session を 2 度開かないためのもの
      const request = db.transaction(
        (tx) => {
          const open = tx
            .select()
            .from(resumeRequests)
            .where(
              and(
                eq(resumeRequests.machine, key.machine),
                eq(resumeRequests.user, key.user),
                eq(resumeRequests.sessionId, sessionId),
                and(isNull(resumeRequests.finishedAtMs), gt(resumeRequests.requestedAtMs, nowMs - REQUEST_TTL_MS)),
              ),
            )
            .get();
          // 既に force で開いている依頼に force 無しで置かれても、force は戻さない
          if (open && !open.force && req.force) {
            tx.update(resumeRequests).set({ force: true }).where(eq(resumeRequests.id, open.id)).run();
            return toRequest({ ...open, force: true }, nowMs);
          }
          if (open) return toRequest(open, nowMs);

          const id = Bun.randomUUIDv7();
          tx.insert(resumeRequests)
            .values({
              id,
              machine: key.machine,
              user: key.user,
              sessionId,
              force: req.force,
              requestedAtMs: nowMs,
              waitSeconds: req.waitSeconds,
            })
            .run();
          return toRequest(
            {
              id,
              machine: key.machine,
              user: key.user,
              sessionId,
              force: req.force,
              requestedAtMs: nowMs,
              claimedAtMs: null,
              finishedAtMs: null,
              outcome: ResumeOutcome.UNSPECIFIED,
              detail: "",
              exitCode: 0,
              claimToken: "",
              waitSeconds: req.waitSeconds,
            },
            nowMs,
          );
        },
        { behavior: "immediate" },
      );

      return { $typeName: "ccx.v1.RequestResumeResponse", request };
    },

    listResumeRequests(req) {
      const where: SQL[] = [];
      if (req.machine) where.push(eq(resumeRequests.machine, req.machine));
      if (req.user) where.push(eq(resumeRequests.user, req.user));
      if (req.sessionId) where.push(eq(resumeRequests.sessionId, req.sessionId.toLowerCase()));

      const nowMs = now();
      const rows = db
        .select()
        .from(resumeRequests)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(resumeRequests.requestedAtMs), desc(sql`rowid`))
        .limit(clampLimit(req.limit))
        .all();

      return {
        $typeName: "ccx.v1.ListResumeRequestsResponse",
        requests: rows.map((r) => toRequest(r, nowMs)),
      };
    },

    claimResume(req) {
      if (!req.machine || !req.user) throw invalid("machine and user are required");
      const nowMs = now();

      // 選ぶのと claim_token を振って claimed_at を付けるのを 1 トランザクションにする。別のプロセスが
      // 同じ DB を開いているときにも、選んでから書くまでのあいだに割り込まれないようにする (immediate)
      const claimed = db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(resumeRequests)
            .where(
              and(
                eq(resumeRequests.machine, req.machine),
                eq(resumeRequests.user, req.user),
                and(
                  isNull(resumeRequests.finishedAtMs),
                  // 期限を過ぎた依頼は取らない。置いた人が期限切れとして読む
                  gt(resumeRequests.requestedAtMs, nowMs - REQUEST_TTL_MS),
                  or(isNull(resumeRequests.claimedAtMs), lte(resumeRequests.claimedAtMs, nowMs - CLAIM_TIMEOUT_MS)),
                ),
              ),
            )
            .orderBy(asc(resumeRequests.requestedAtMs), asc(sql`rowid`))
            .limit(1)
            .get();
          if (!row) return undefined;
          // 取るたびに振り直す。取り直された後に返ってきた古い結果を断るため
          const claimToken = crypto.randomUUID();
          tx.update(resumeRequests)
            .set({ claimedAtMs: nowMs, claimToken })
            .where(eq(resumeRequests.id, row.id))
            .run();
          return { ...row, claimedAtMs: nowMs, claimToken };
        },
        { behavior: "immediate" },
      );

      return {
        $typeName: "ccx.v1.ClaimResumeResponse",
        request: claimed ? toRequest(claimed, nowMs) : undefined,
      };
    },

    finishResume(req) {
      if (req.outcome !== ResumeOutcome.OPENED && req.outcome !== ResumeOutcome.FAILED) {
        throw invalid(`outcome is not OPENED nor FAILED: ${req.outcome}`);
      }

      const nowMs = now();
      const row = db.select().from(resumeRequests).where(eq(resumeRequests.id, req.id)).get();
      if (!row) throw new ConnectError(`no resume request: ${req.id}`, Code.NotFound);
      // 取った agent だけが結果を返す。取っていない依頼や終わった依頼に書き戻すと、
      // 結果の 2 回書きを黙って受け入れてしまう。行は変えない。
      if (row.claimedAtMs === null || row.finishedAtMs !== null) {
        throw new ConnectError(`the resume request is not claimed: ${req.id}`, Code.FailedPrecondition);
      }
      // 取り直された後に返ってきた古い結果は、最後の token が違うので断る
      if (row.claimToken !== "" && row.claimToken !== req.claimToken) {
        throw new ConnectError(`the resume request ${req.id} was claimed again; this result is stale`, Code.FailedPrecondition);
      }

      const detail = capDetail(req.detail);
      db.update(resumeRequests)
        .set({ finishedAtMs: nowMs, outcome: req.outcome, detail, exitCode: req.exitCode })
        .where(eq(resumeRequests.id, req.id))
        .run();

      return {
        $typeName: "ccx.v1.FinishResumeResponse",
        request: toRequest(
          {
            ...row,
            finishedAtMs: nowMs,
            outcome: req.outcome,
            detail,
            exitCode: req.exitCode,
          },
          nowMs,
        ),
      };
    },
  };
}