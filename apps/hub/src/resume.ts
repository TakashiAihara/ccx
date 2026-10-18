import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "./db/open.ts";
import { resumeRequests } from "./db/schema.ts";
import { ResumeOutcome, ResumeService, type ResumeRequest } from "@ccx/proto/ccx/v1/resume_pb.ts";

/**
 * resume.proto の実装 (#261、docs/design/resume.md)。人が依頼を置き、その session のあるマシンの ccx-agent が
 * 取りに行って、開いた結果を返す。
 *
 * center から ccx-agent へは繋がない。待ち合いはこの表の中だけで解決する: 誰が取ったかは
 * claimed_at、終わったかは finished_at。依頼がどの段階にあるかは phase() 1 か所で決める。
 */

/** listResumeRequests の既定と上限 (resume.proto)。0 は「指定なし」なので既定に落ちる */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** 8-4-4-4-12。大文字で来ても同じ値として扱う */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 誰も取らないまま依頼が有効でいる時間。過ぎた依頼は agent が取らず、同じ session に新しい依頼を置ける。
 * 期限が無いと、置きっぱなしの一件がその後の依頼を塞ぎ続け、相手のマシンが何日も後に上がった時点で開かれる。
 * 取られた後の依頼には当てない (実行中のものは claimLeaseMs が決める)
 */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** 依頼に載せられる待ちの上限。agent は依頼を 1 件ずつ並べずに走らせるが、1 件の実行がこれより長く居座らないように */
export const MAX_WAIT_SECONDS = 600;

/** CLI の `--wait` の既定 (apps/cli/src/resume.ts の 40 秒)。依頼が待ちを指定しないときに使う */
const DEFAULT_WAIT_SECONDS = 40;

/**
 * 取られた依頼を「実行中」とみなす時間。agent は 1 回の実行を待ち + 60 秒で打ち切る (resume.go の
 * DefaultRunTimeout)。それにもう 60 秒を足し、打ち切られた実行の結果が戻る前に別の agent が取り直さないようにする
 */
export function claimLeaseMs(waitSeconds: number): number {
  return ((waitSeconds || DEFAULT_WAIT_SECONDS) + 120) * 1000;
}

/** detail が持つ上限 (resume.proto)。UTF-8 のバイトで数え、古いところから文字の境界で切る (agent の detailOf と同じ単位) */
export const DETAIL_CAP = 4096;

type Row = typeof resumeRequests.$inferSelect;

/**
 * 依頼の段階。
 * - finished: 結果が返った
 * - running: 取られて、その実行の上限 (claimLeaseMs) の内にある。同じ session の次の依頼を塞ぐ
 * - pending: 誰も取っていないか、取られたが上限を過ぎた (agent が落ちた) 依頼で、置いてから REQUEST_TTL_MS の内。取れる
 * - expired: 上のどれでもない。取らず、次の依頼を塞がない
 */
export function phase(r: Pick<Row, "requestedAtMs" | "claimedAtMs" | "finishedAtMs" | "waitSeconds">, nowMs: number): "finished" | "running" | "pending" | "expired" {
  if (r.finishedAtMs !== null) return "finished";
  if (r.claimedAtMs !== null && nowMs < r.claimedAtMs + claimLeaseMs(r.waitSeconds)) return "running";
  if (r.requestedAtMs > nowMs - REQUEST_TTL_MS) return "pending";
  return "expired";
}

const invalid = (why: string): ConnectError => new ConnectError(why, Code.InvalidArgument);

function clampLimit(v: number): number {
  if (!v) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

/** NOT NULL の行をそのまま proto の依頼に写す。時刻の NULL は「その段階に居ない」 */
function toRequest(r: Row, nowMs: number): ResumeRequest {
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
    // 保存しない。置いた時刻・取った時刻と「今の時計」から読み手ごとに決める
    expired: phase(r, nowMs) === "expired",
    waitSeconds: r.waitSeconds,
  };
}

/** UTF-8 で DETAIL_CAP バイトを超えたら末尾だけを残す。切り口が文字の途中なら次の文字の頭まで進める */
function capDetail(detail: string): string {
  const bytes = new TextEncoder().encode(detail);
  if (bytes.length <= DETAIL_CAP) return detail;
  let start = bytes.length - DETAIL_CAP;
  // 0b10xxxxxx は文字の続きのバイト
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/** 終わっていない依頼を (machine, user) で引く。段階は JS の phase() で決める (時計と待ちの組み合わせを SQL に写さない) */
function unfinished(tx: Pick<Db, "select">, machine: string, user: string, sessionId?: string): Row[] {
  const where: SQL[] = [eq(resumeRequests.machine, machine), eq(resumeRequests.user, user), isNull(resumeRequests.finishedAtMs)];
  if (sessionId) where.push(eq(resumeRequests.sessionId, sessionId));
  return tx
    .select()
    .from(resumeRequests)
    .where(and(...where))
    .orderBy(resumeRequests.requestedAtMs, sql`rowid`)
    .all();
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
      if (req.waitSeconds > MAX_WAIT_SECONDS) {
        throw invalid(`wait_seconds is at most ${MAX_WAIT_SECONDS}: ${req.waitSeconds}`);
      }
      const nowMs = now();

      // 探して作るまでを 1 トランザクションにする。別のプロセスが同じ DB を開いているときにも、
      // 読んでから書くまでのあいだに割り込まれないようにする (immediate は書き込む前に write ロックを取る)。
      // 同じ session を 2 度開かないためのもの
      const request = db.transaction(
        (tx) => {
          const open = unfinished(tx, key.machine, key.user, sessionId).find((r) => {
            const p = phase(r, nowMs);
            return p === "running" || p === "pending";
          });
          // force は、まだ誰も取っていない依頼にだけ足せる。取った agent はもう force 無しで走っている
          if (open && open.claimedAtMs === null && !open.force && req.force) {
            tx.update(resumeRequests).set({ force: true }).where(eq(resumeRequests.id, open.id)).run();
            return toRequest({ ...open, force: true }, nowMs);
          }
          if (open) return toRequest(open, nowMs);

          const row: Row = {
            id: Bun.randomUUIDv7(),
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
          };
          tx.insert(resumeRequests).values(row).run();
          return toRequest(row, nowMs);
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
          const row = unfinished(tx, req.machine, req.user).find((r) => phase(r, nowMs) === "pending");
          if (!row) return undefined;
          // 取るたびに振り直す。取り直された後に返ってきた古い結果を断るため
          const claimToken = Bun.randomUUIDv7();
          tx.update(resumeRequests).set({ claimedAtMs: nowMs, claimToken }).where(eq(resumeRequests.id, row.id)).run();
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
      const detail = capDetail(req.detail);

      // 読んで確かめてから書くまでを 1 トランザクションにする (2 つの結果が同時に来ても 1 つしか書かない)
      const finished = db.transaction(
        (tx) => {
          const row = tx.select().from(resumeRequests).where(eq(resumeRequests.id, req.id)).get();
          if (!row) throw new ConnectError(`no resume request: ${req.id}`, Code.NotFound);
          // 取った agent だけが結果を返す。取っていない依頼や終わった依頼に書き戻すと、結果の 2 回書きを
          // 黙って受け入れてしまう。行は変えない
          if (row.claimedAtMs === null || row.finishedAtMs !== null) {
            throw new ConnectError(`the resume request is not claimed: ${req.id}`, Code.FailedPrecondition);
          }
          // 取り直された後に返ってきた古い結果は、最後の token が違うので断る
          if (row.claimToken !== req.claimToken) {
            throw new ConnectError(`the resume request ${req.id} was claimed again; this result is stale`, Code.FailedPrecondition);
          }
          tx.update(resumeRequests)
            .set({ finishedAtMs: nowMs, outcome: req.outcome, detail, exitCode: req.exitCode })
            .where(eq(resumeRequests.id, req.id))
            .run();
          return { ...row, finishedAtMs: nowMs, outcome: req.outcome, detail, exitCode: req.exitCode };
        },
        { behavior: "immediate" },
      );

      return { $typeName: "ccx.v1.FinishResumeResponse", request: toRequest(finished, nowMs) };
    },
  };
}
