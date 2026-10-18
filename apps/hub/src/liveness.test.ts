/**
 * 動いているか (#261): ccx-agent が送る「動いている session の一覧」(PRODUCER_CCX_AGENT_RUNNING) から読む。
 *
 * 守りたいのは 3 つ。
 *   - 読むのは (machine, user) ごとの最新の一覧だけ。古い一覧に居たことは running の根拠にならない
 *   - 一覧が無い / 古い (machine, user) は unknown。止まっているとは言わない
 *   - 一覧の event は session の一覧 (件数 / last_seen) に混ざらない
 */

import { beforeEach, expect, test } from "bun:test";

import { openDb, type Db } from "./db/open.ts";
import { ingest, listSessions, RUNNING_FRESH_MS, type IncomingEvent } from "./store.ts";

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

function running(ids: string[], at: number, over: Partial<IncomingEvent> = {}): IncomingEvent {
  n += 1;
  return {
    eventId: `r${n}`,
    machine: "m1",
    user: "dev",
    seq: n,
    receivedAtMs: at,
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
  ingest(db, [hook(A, NOW - 60_000), hook(B, NOW - 50_000), running([A], NOW - 10_000)]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "running", [B]: "stopped" });
});

test("古い一覧に居ても、最新の一覧に居なければ stopped", () => {
  ingest(db, [hook(A, NOW - 60_000), running([A], NOW - 40_000), running([], NOW - 10_000)]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "stopped" });
});

test("到着順ではなく received_at の新しい一覧を読む", () => {
  ingest(db, [hook(A, NOW - 60_000), running([], NOW - 10_000), running([A], NOW - 40_000)]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "stopped" });
});

test("最新の一覧が 5 分より古ければ unknown (居ても居なくても)", () => {
  ingest(db, [hook(A, NOW - 900_000), hook(B, NOW - 900_000), running([A], NOW - 300_001)]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "unknown", [B]: "unknown" });
});

test("ちょうど 5 分前の一覧はまだ新しい", () => {
  ingest(db, [hook(A, NOW - 900_000), running([], NOW - 300_000)]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "stopped" });
});

test("一覧が 1 度も来ていない (machine, user) は unknown", () => {
  ingest(db, [hook(A, NOW - 60_000)]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "unknown" });
});

test("一覧は (machine, user) ごと。別ユーザーの一覧で決めない", () => {
  ingest(db, [
    hook(A, NOW - 60_000),
    hook(B, NOW - 60_000, { user: "alice" }),
    running([B], NOW - 10_000, { user: "alice" }),
    running([], NOW - 10_000),
  ]);
  const rows = listSessions(db, { limit: 100, nowMs: NOW });
  expect(rows.map((r) => [r.user, r.sessionId, r.liveness]).sort()).toEqual([
    ["alice", B, "running"],
    ["dev", A, "stopped"],
  ]);
});

test("読めない一覧の payload は無いものとして、その前の読める一覧を使う", () => {
  ingest(db, [
    hook(A, NOW - 60_000),
    running([A], NOW - 30_000),
    { ...running([], NOW - 10_000), payload: new TextEncoder().encode("{not json") },
  ]);
  expect(liveness(listSessions(db, { limit: 100, nowMs: NOW }))).toEqual({ [A]: "running" });
});

test("一覧の event は session の件数にも last_seen にも混ざらない", () => {
  ingest(db, [hook(A, NOW - 60_000), running([A], NOW - 10_000)]);
  const [row] = listSessions(db, { limit: 100, nowMs: NOW });
  expect(row?.eventCount).toBe(1);
  expect(row?.lastSeenMs).toBe(NOW - 60_000);
});

test("stoppedOnly は stopped で archived でないものだけ。limit は絞った後に効く", () => {
  ingest(db, [
    hook(A, NOW - 70_000),
    hook(B, NOW - 60_000),
    hook(C, NOW - 50_000),
    hook("dddddddd-dddd-4ddd-8ddd-dddddddddddd", NOW - 40_000),
    hook("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", NOW - 30_000),
    mark(B, true, NOW - 20_000),
    running(["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"], NOW - 10_000),
  ]);
  const all = listSessions(db, { limit: 100, nowMs: NOW, stoppedOnly: true });
  expect(all.map((r) => r.sessionId)).toEqual([C, A]);
  const one = listSessions(db, { limit: 1, nowMs: NOW, stoppedOnly: true });
  expect(one.map((r) => r.sessionId)).toEqual([C]);
});

test("stoppedOnly は unknown を含めない", () => {
  ingest(db, [hook(A, NOW - 60_000)]);
  expect(listSessions(db, { limit: 100, nowMs: NOW, stoppedOnly: true })).toEqual([]);
});
