/**
 * 動いているか (#261): ccx-agent が送る「動いている session の一覧」(PRODUCER_CCX_AGENT_RUNNING) から読む。
 *
 * 守りたいのは 4 つ。
 *   - 一覧は (machine, user) ごとに最新の 1 件だけを持つ (events に積まない)。古い一覧に居たことは running の根拠にならない
 *   - 鮮度は center が受け取った時刻 (center の時計) で決める。agent の時計は見ない
 *   - 一覧が無い / 古い (machine, user) は unknown。止まっているとは言わない
 *   - 読めない一覧は断る (「何も動いていない」として持たない)
 */

import { beforeEach, expect, test } from "bun:test";

import { openDb, type Db } from "./db/open.ts";
import { ingest, listEvents, listSessions, RUNNING_FRESH_MS, type IncomingEvent } from "./store.ts";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const NOW = 1_800_000_000_000;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let n = 0;
let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
});

function hook(sessionId: string, at: number, over: Partial<IncomingEvent> = {}): IncomingEvent {
  n += 1;
  return {
    eventId: `h${n}`,
    machine: "m1",
    user: "dev",
    seq: n,
    receivedAtMs: at,
    producer: 1,
    payload: enc({ session_id: sessionId, hook_event_name: "Stop", cwd: "/w" }),
    ...over,
  };
}

/** agentAt は agent の時計。鮮度には効かないことを見るため、既定でわざと大きくずらしてある */
function running(ids: string[], over: Partial<IncomingEvent> = {}, agentAt = NOW - 86_400_000): IncomingEvent {
  n += 1;
  return {
    eventId: `r${n}`,
    machine: "m1",
    user: "dev",
    seq: n,
    receivedAtMs: agentAt,
    producer: 3,
    payload: enc({ session_ids: ids }),
    ...over,
  };
}

function mark(sessionId: string, archived: boolean, at: number): IncomingEvent {
  n += 1;
  return {
    eventId: `s${n}`,
    machine: "m1",
    user: "dev",
    seq: n,
    receivedAtMs: at,
    producer: 2,
    payload: enc({ session_id: sessionId, state: { archived, label: "", task: "" }, rev: at }),
  };
}

const liveness = (rows: ReturnType<typeof listSessions>) => Object.fromEntries(rows.map((r) => [r.sessionId, r.liveness]));

test("鮮度の窓は 5 分", () => {
  expect(RUNNING_FRESH_MS).toBe(300_000);
});

test("最新の一覧に居れば running、居なければ stopped", () => {
  ingest(db, [hook(A, NOW - 60_000), hook(B, NOW - 50_000)], NOW - 50_000);
  ingest(db, [running([A])], NOW - 10_000);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "running", [B]: "stopped" });
});

test("一覧は events に積まず、ListEvents にも session の件数にも出ない", () => {
  ingest(db, [hook(A, NOW - 60_000)], NOW - 60_000);
  expect(ingest(db, [running([A])], NOW - 10_000)).toBe(1);
  expect(listEvents(db, { includePayload: false, limit: 100 }).map((e) => e.eventId)).toEqual(["h1"]);
  const [row] = listSessions(db, { limit: 100, nowMs: NOW });
  expect(row?.eventCount).toBe(1);
  expect(row?.lastSeenMs).toBe(NOW - 60_000);
});

test("後から受け取った一覧が前の一覧を置き換える (agent の時計の前後は見ない)", () => {
  ingest(db, [hook(A, NOW - 60_000)], NOW - 60_000);
  ingest(db, [running([A], {}, NOW + 3_600_000)], NOW - 40_000);
  ingest(db, [running([], {}, NOW - 3_600_000)], NOW - 10_000);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "stopped" });
});

test("鮮度は center が受け取った時刻で決める: agent の時計が 1 日遅れていても、今受け取った一覧は新しい", () => {
  ingest(db, [hook(A, NOW - 60_000)], NOW - 60_000);
  ingest(db, [running([A], {}, NOW - 86_400_000)], NOW - 1_000);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "running" });
});

test("center が 5 分より前に受け取った一覧なら unknown (agent の時計が先に進んでいても)", () => {
  ingest(db, [hook(A, NOW - 900_000), hook(B, NOW - 900_000)], NOW - 900_000);
  ingest(db, [running([A], {}, NOW + 3_600_000)], NOW - 300_001);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "unknown", [B]: "unknown" });
});

test("ちょうど 5 分前に受け取った一覧はまだ新しい", () => {
  ingest(db, [hook(A, NOW - 900_000)], NOW - 900_000);
  ingest(db, [running([])], NOW - 300_000);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "stopped" });
});

test("一覧が 1 度も来ていない (machine, user) は unknown", () => {
  ingest(db, [hook(A, NOW - 60_000)], NOW - 60_000);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "unknown" });
});

test("一覧は (machine, user) ごと。別ユーザーの一覧で決めない", () => {
  ingest(db, [hook(A, NOW - 60_000), hook(B, NOW - 60_000, { user: "alice" })], NOW - 60_000);
  ingest(db, [running([B], { user: "alice" }), running([])], NOW - 10_000);
  const rows = listSessions(db, { limit: 100, nowMs: NOW });
  expect(rows.map((r) => [r.user, r.sessionId, r.liveness]).sort()).toEqual([
    ["alice", B, "running"],
    ["dev", A, "stopped"],
  ]);
});

test("読めない一覧はバッチごと断り、前の一覧も hook も変えない", () => {
  ingest(db, [hook(A, NOW - 60_000)], NOW - 60_000);
  ingest(db, [running([A])], NOW - 30_000);
  for (const payload of [new TextEncoder().encode("{not json"), enc({ session_ids: "x" }), enc({ session_ids: [1] }), enc({})]) {
    expect(() => ingest(db, [hook(B, NOW - 20_000), { ...running([]), payload }], NOW - 10_000)).toThrow();
  }
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "running" });
});

test("stoppedOnly は stopped で archived でないものだけ。limit は絞った後に効く", () => {
  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  ingest(db, [hook(A, NOW - 70_000), hook(B, NOW - 60_000), hook(C, NOW - 50_000), hook(D, NOW - 40_000), hook(E, NOW - 30_000), mark(B, true, NOW - 20_000)], NOW - 20_000);
  ingest(db, [running([D, E])], NOW - 10_000);
  expect(listSessions(db, { limit: 100, nowMs: NOW, stoppedOnly: true }).map((r) => r.sessionId)).toEqual([C, A]);
  expect(listSessions(db, { limit: 1, nowMs: NOW, stoppedOnly: true }).map((r) => r.sessionId)).toEqual([C]);
});

test("stoppedOnly は unknown を含めない", () => {
  ingest(db, [hook(A, NOW - 60_000)], NOW - 60_000);
  expect(listSessions(db, { limit: 100, nowMs: NOW, stoppedOnly: true })).toEqual([]);
});

test("stoppedOnly は 1 万を超える session でも、archived を読んで外し、limit で切る", () => {
  const ids = Array.from({ length: 11_000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  ingest(db, ids.map((id, i) => hook(id, NOW - 100_000 + i)), NOW - 60_000);
  ingest(db, [mark(ids[0]!, true, NOW - 50_000), running([])], NOW - 10_000);
  const rows = listSessions(db, { limit: 1000, nowMs: NOW, stoppedOnly: true });
  expect(rows.length).toBe(1000);
  expect(rows.some((r) => r.sessionId === ids[0])).toBe(false);
});
