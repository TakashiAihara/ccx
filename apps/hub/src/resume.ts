import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { and, asc, desc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";

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

const invalid = (why: string): ConnectError => new ConnectError(why, Code.InvalidArgument);

function clampLimit(v: number): number {
  if (!v) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

/** NOT NULL の行をそのまま proto の依頼に写す。時刻の NULL は「その段階に居ない」 */
function toRequest(r: typeof resumeRequests.$inferSelect): ResumeRequest {
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
  };
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

      // 2 人同時に置いても 1 つだけにする。読む前に write ロックを取る immediate で、
      // 探して作るまでを 1 トランザクションにして、見つからなかったときだけ挿入する。
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
                isNull(resumeRequests.finishedAtMs),
              ),
            )
            .get();
          if (open) return toRequest(open);

          const id = Bun.randomUUIDv7();
          const requestedAtMs = now();
          tx.insert(resumeRequests)
            .values({
              id,
              machine: key.machine,
              user: key.user,
              sessionId,
              force: req.force,
              requestedAtMs,
            })
            .run();
          return toRequest({
            id,
            machine: key.machine,
            user: key.user,
            sessionId,
            force: req.force,
            requestedAtMs,
            claimedAtMs: null,
            finishedAtMs: null,
            outcome: ResumeOutcome.UNSPECIFIED,
            detail: "",
            exitCode: 0,
          });
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

      const rows = db
        .select()
        .from(resumeRequests)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(resumeRequests.requestedAtMs), desc(sql`rowid`))
        .limit(clampLimit(req.limit))
        .all();

      return {
        $typeName: "ccx.v1.ListResumeRequestsResponse",
        requests: rows.map(toRequest),
      };
    },

    claimResume(req) {
      if (!req.machine || !req.user) throw invalid("machine and user are required");
      const nowMs = now();

      // 選ぶのと claimed_at を付けるのを 1 トランザクションにする。挟むと 2 つの
      // ccx-agent に同じ依頼を渡す。読む前に write ロックを取ってから選ぶ immediate。
      const claimed = db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(resumeRequests)
            .where(
              and(
                eq(resumeRequests.machine, req.machine),
                eq(resumeRequests.user, req.user),
                isNull(resumeRequests.finishedAtMs),
                or(isNull(resumeRequests.claimedAtMs), lte(resumeRequests.claimedAtMs, nowMs - CLAIM_TIMEOUT_MS)),
              ),
            )
            .orderBy(asc(resumeRequests.requestedAtMs), asc(sql`rowid`))
            .limit(1)
            .get();
          if (!row) return undefined;
          tx.update(resumeRequests).set({ claimedAtMs: nowMs }).where(eq(resumeRequests.id, row.id)).run();
          return { ...row, claimedAtMs: nowMs };
        },
        { behavior: "immediate" },
      );

      return {
        $typeName: "ccx.v1.ClaimResumeResponse",
        request: claimed ? toRequest(claimed) : undefined,
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

      db.update(resumeRequests)
        .set({ finishedAtMs: nowMs, outcome: req.outcome, detail: req.detail, exitCode: req.exitCode })
        .where(eq(resumeRequests.id, req.id))
        .run();

      return {
        $typeName: "ccx.v1.FinishResumeResponse",
        request: toRequest({
          ...row,
          finishedAtMs: nowMs,
          outcome: req.outcome,
          detail: req.detail,
          exitCode: req.exitCode,
        }),
      };
    },
  };
}