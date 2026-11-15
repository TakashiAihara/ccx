import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

import type { Db } from "./db/open.ts";
import { relayMessages, relayReceivers } from "./db/schema.ts";
import { capDetail, wakeAgent } from "./resume.ts";
import {
  MessageRelayService,
  RelayedMessageSchema,
  SendRequestSchema,
  SendResponseSchema,
  type RelayedMessage,
  type SendResponse,
} from "@ccx/proto/ccx/v1/message_pb.ts";

/**
 * message.proto の MessageRelayService (#138、docs/design/messaging.md)。送り手の ccx-agent が置いたメッセージを
 * 宛先の ccx-agent が 1 度だけ取り、届けた ack を書き、送り手が読み返す。
 */

/** 取られないまま置いておく時間。過ぎた行は渡さないので、送り手は「送っていない」と言える */
export const CLAIM_TTL_MS = 30_000;

/**
 * 行を残す時間。送り手が ack を読み終えるには足りる長さで、本文を center に溜め続けない。送り手は question / done を
 * 最長 1 時間待てる (SendRequest.wait_seconds、agent の MaxWait) ので、それより長く取る
 */
export const KEEP_MS = 2 * 60 * 60 * 1000;

/** 置ける SendRequest の大きさ。本文の上限 (agent の MaxBody、64 KiB) に宛先と見出しの分を足した程度 */
export const MAX_REQUEST_BYTES = 70 * 1024;

/**
 * 1 通の ack の数の上限。届け方が出す ack は queued / sent / working・not-started / done・wait-ended の 4 つと、question が
 * agent の上限 (MaxQuestionAcks、8) まで
 */
export const MAX_ACKS = 16;

/** 1 つの question の ack に残す問いの数と、1 問の選択肢の数 */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 16;

/** 宛先を知らないと断るときに添える、名乗っている宛先の数の上限 */
const MAX_KNOWN = 10;

/**
 * 取りに来たことの無い (machine, user) 宛ての置き方を断る理由 (#319)。置いても取る agent が居ないので、送り手は
 * 30 秒待ってから「agent が動いていないのでは」と言うことになり、名前の綴り違い (uname -n の大文字など) に辿り着けない。
 * 大文字小文字だけ違う宛先を先頭に並べる。取りに来たことはあるが今は止まっている agent は、従来どおり待ちで分かる
 */
function unknownTarget(db: Db, machine: string, user: string): string | null {
  const hit = db.select({ m: relayReceivers.machine }).from(relayReceivers).where(and(eq(relayReceivers.machine, machine), eq(relayReceivers.user, user))).get();
  if (hit) return null;
  const known = db.select({ machine: relayReceivers.machine, user: relayReceivers.user }).from(relayReceivers).all();

  const near = (k: { machine: string; user: string }) => k.machine.toLowerCase() === machine.toLowerCase() && k.user.toLowerCase() === user.toLowerCase();
  const names = known
    .sort((a, b) => Number(near(b)) - Number(near(a)) || `${a.machine}/${a.user}`.localeCompare(`${b.machine}/${b.user}`))
    .map((k) => `${k.machine}/${k.user}`);
  const listed = names.length === 0 ? "none has yet" : `these have: ${names.slice(0, MAX_KNOWN).join(", ")}${names.length > MAX_KNOWN ? ", …" : ""}`;
  return capDetail(`no ccx-agent has taken messages from this center as ${machine}/${user}; ${listed}`);
}

/** Connect のコードの最大 (UNAUTHENTICATED = 16)。送り手はこの値をそのままエラーのコードにする */
const MAX_CODE = 16;

type Row = typeof relayMessages.$inferSelect;
type Ack = {
  state: number;
  detail: string;
  // question / done の中身。古い行には無い
  text?: string;
  questions?: { question: string; header: string; options: { label: string; description: string }[] }[];
};

const invalid = (why: string): ConnectError => new ConnectError(why, Code.InvalidArgument);

function toMessage(r: Row, nowMs: number, withToken = false): RelayedMessage {
  const acks = (JSON.parse(r.acks) as Ack[]).map((a) => create(SendResponseSchema, a));
  return create(RelayedMessageSchema, {
    id: r.id,
    request: fromBinary(SendRequestSchema, r.request),
    putAt: timestampFromMs(r.putAtMs),
    claimedAt: r.claimedAtMs === null ? undefined : timestampFromMs(r.claimedAtMs),
    finishedAt: r.finishedAtMs === null ? undefined : timestampFromMs(r.finishedAtMs),
    acks,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    notTyped: r.notTyped,
    expired: r.claimedAtMs === null && r.putAtMs <= nowMs - CLAIM_TTL_MS,
    claimToken: withToken ? r.claimToken : "",
  });
}

/** ack を行に書く形。文字列は detail と同じく末尾の 4096 バイトに切り、問いと選択肢の数にも上限を置く */
const ackRows = (acks: SendResponse[]): string =>
  JSON.stringify(
    acks.map(
      (a): Ack => ({
        state: a.state,
        detail: capDetail(a.detail),
        text: capDetail(a.text),
        questions: a.questions.slice(0, MAX_QUESTIONS).map((q) => ({
          question: capDetail(q.question),
          header: capDetail(q.header),
          options: q.options.slice(0, MAX_OPTIONS).map((o) => ({ label: capDetail(o.label), description: capDetail(o.description) })),
        })),
      }),
    ),
  );

export function relayImpl(db: Db, now: () => number, agentToken?: string): ServiceImpl<typeof MessageRelayService> {
  return {
    putMessage(req) {
      const r = req.request;
      if (!r?.machine || !r.user) throw invalid("request.machine and request.user are required");
      const bytes = toBinary(SendRequestSchema, r);
      if (bytes.length > MAX_REQUEST_BYTES) throw invalid(`request is ${bytes.length} bytes, over the ${MAX_REQUEST_BYTES}-byte limit`);
      // InvalidArgument は送り手の agent が「置かれていない (打っていない)」と読むコード (relay.go の putNeverStored)
      const unknown = unknownTarget(db, r.machine, r.user);
      if (unknown) throw invalid(unknown);
      const nowMs = now();

      const row: Row = {
        id: Bun.randomUUIDv7(),
        machine: r.machine,
        user: r.user,
        request: Buffer.from(bytes),
        putAtMs: nowMs,
        claimedAtMs: null,
        finishedAtMs: null,
        acks: "[]",
        errorCode: 0,
        errorMessage: "",
        notTyped: false,
        claimToken: "",
      };
      db.transaction(
        (tx) => {
          tx.delete(relayMessages).where(lt(relayMessages.putAtMs, nowMs - KEEP_MS)).run();
          tx.insert(relayMessages).values(row).run();
        },
        { behavior: "immediate" },
      );

      // 起こしは次の polling を待たせないためだけのもの。届かなくても polling が拾う
      if (agentToken) {
        try {
          wakeAgent(db, r.machine, r.user, agentToken, nowMs);
        } catch (err: unknown) {
          console.error(`wake ${r.machine}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { $typeName: "ccx.v1.PutMessageResponse", message: toMessage(row, nowMs) };
    },

    getMessage(req) {
      const row = db.select().from(relayMessages).where(eq(relayMessages.id, req.id)).get();
      if (!row) throw new ConnectError(`no message: ${req.id}`, Code.NotFound);
      return { $typeName: "ccx.v1.GetMessageResponse", message: toMessage(row, now()) };
    },

    claimMessage(req) {
      if (!req.machine || !req.user) throw invalid("machine and user are required");
      let nowMs = 0;

      // 選ぶのと claimed_at を付けるのを 1 トランザクションにする: 同じ行を 2 つの agent に渡さない。
      // 時刻は書き込みロックを取ってから読む。ロック待ち (busy_timeout、最大 5 秒) の前の時刻で期限を見ると、
      // 送り手が expired と読んで「送っていない」と言った行を取って打ってしまう
      const claimed = db.transaction(
        (tx) => {
          nowMs = now();
          tx.insert(relayReceivers)
            .values({ machine: req.machine, user: req.user, claimedAtMs: nowMs })
            .onConflictDoNothing()
            .run();
          const row = tx
            .select()
            .from(relayMessages)
            .where(
              and(
                eq(relayMessages.machine, req.machine),
                eq(relayMessages.user, req.user),
                isNull(relayMessages.claimedAtMs),
                sql`${relayMessages.putAtMs} > ${nowMs - CLAIM_TTL_MS}`,
              ),
            )
            .orderBy(relayMessages.putAtMs, sql`rowid`)
            .get();
          if (!row) return undefined;
          const claimToken = Bun.randomUUIDv7();
          tx.update(relayMessages).set({ claimedAtMs: nowMs, claimToken }).where(eq(relayMessages.id, row.id)).run();
          return { ...row, claimedAtMs: nowMs, claimToken };
        },
        { behavior: "immediate" },
      );

      return { $typeName: "ccx.v1.ClaimMessageResponse", message: claimed ? toMessage(claimed, nowMs, true) : undefined };
    },

    reportMessage(req) {
      if (req.acks.length > MAX_ACKS) throw invalid(`at most ${MAX_ACKS} acks: ${req.acks.length}`);
      if (!Number.isInteger(req.errorCode) || req.errorCode < 0 || req.errorCode > MAX_CODE) throw invalid(`error_code is not a Connect code: ${req.errorCode}`);
      const nowMs = now();
      db.transaction(
        (tx) => {
          const row = tx.select().from(relayMessages).where(eq(relayMessages.id, req.id)).get();
          if (!row) throw new ConnectError(`no message: ${req.id}`, Code.NotFound);
          if (row.claimedAtMs === null || row.finishedAtMs !== null || row.claimToken !== req.claimToken) {
            throw new ConnectError(`the message ${req.id} is not claimed with this token, or is finished`, Code.FailedPrecondition);
          }
          // ack の一覧は 1 回の配送の中で伸びるだけ。agent が打ち切った古い報告が後から届いても、
          // 保存済みより短い一覧で戻さない
          const stored = (JSON.parse(row.acks) as Ack[]).length;
          const set = {
            ...(req.acks.length >= stored ? { acks: ackRows(req.acks) } : {}),
            ...(req.finished ? { finishedAtMs: nowMs, errorCode: req.errorCode, errorMessage: capDetail(req.errorMessage), notTyped: req.notTyped } : {}),
          };
          if (Object.keys(set).length > 0) tx.update(relayMessages).set(set).where(eq(relayMessages.id, req.id)).run();
        },
        { behavior: "immediate" },
      );
      return { $typeName: "ccx.v1.ReportMessageResponse" };
    },
  };
}
