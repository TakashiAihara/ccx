import { beforeEach, describe, expect, test } from "bun:test";

import { openDb, type Db } from "./db/open.ts";
import { ingest, listEvents, listEventsQuery, listSessions, type IncomingEvent } from "./store.ts";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

type EvOverride = Omit<Partial<IncomingEvent>, "payload"> & { payload?: unknown };

let n = 0;
function ev(over: EvOverride = {}): IncomingEvent {
  n += 1;
  const { payload, ...rest } = over;
  return {
    eventId: `e${n}`,
    machine: "m1",
    user: "dev",
    seq: n,
    receivedAtMs: 1000 + n,
    producer: 1,
    payload: payload instanceof Uint8Array ? payload : enc(payload ?? {}),
    ...rest,
  };
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
});

describe("ingest", () => {
  test("新規は保存され、件数が返る", () => {
    expect(ingest(db, [ev(), ev(), ev()])).toBe(3);
    expect(listEvents(db, { includePayload: false, limit: 10 })).toHaveLength(3);
  });

  test("空のバッチは 0 件で、何も起きない", () => {
    expect(ingest(db, [])).toBe(0);
  });

  test("同じ event_id は二度目に保存されない (at-least-once 転送の正常系)", () => {
    const e = ev({ payload: { session_id: "s1" } });
    expect(ingest(db, [e])).toBe(1);
    expect(ingest(db, [e])).toBe(0);
    expect(listEvents(db, { includePayload: false, limit: 10 })).toHaveLength(1);
  });

  test("accepted はバッチ件数と一致しないことがある。既知が混じれば小さくなる", () => {
    const known = ev();
    ingest(db, [known]);
    expect(ingest(db, [known, ev(), ev()])).toBe(2);
  });

  test("同じバッチの中の重複も 1 件として入る", () => {
    const e = ev();
    expect(ingest(db, [e, { ...e }])).toBe(1);
  });

  test("payload から派生値が作られる", () => {
    ingest(db, [
      ev({
        payload: {
          session_id: "s1",
          hook_event_name: "Stop",
          cwd: "/w",
          transcript_path: "/t.jsonl",
        },
      }),
    ]);
    const [e] = listEvents(db, { includePayload: false, limit: 1 });
    expect(e).toMatchObject({
      parsed: true,
      sessionId: "s1",
      hookEventName: "Stop",
      cwd: "/w",
      transcriptPath: "/t.jsonl",
    });
  });

  test("読めない payload も落とさず、parsed=false で残る", () => {
    ingest(db, [ev({ payload: new Uint8Array([0xff, 0x00, 0xfe]) })]);
    const [e] = listEvents(db, { includePayload: true, limit: 1 });
    expect(e!.parsed).toBe(false);
    expect(e!.sessionId).toBe("");
    // 生バイトは失われない。パーサを直せば読み直せる、が設計の核。
    expect(Array.from(e!.payload!)).toEqual([0xff, 0x00, 0xfe]);
  });

  test("500 件を超えるバッチも 1 トランザクションで入る", () => {
    const batch = Array.from({ length: 1200 }, () => ev());
    expect(ingest(db, batch)).toBe(1200);
  });
});

describe("listEvents", () => {
  beforeEach(() => {
    ingest(db, [
      ev({ machine: "m1", user: "dev", payload: { session_id: "s1", hook_event_name: "SessionStart" } }),
      ev({ machine: "m1", user: "dev", payload: { session_id: "s1", hook_event_name: "Stop" } }),
      ev({ machine: "m2", user: "dev", payload: { session_id: "s2", hook_event_name: "Stop" } }),
      ev({ machine: "m1", user: "other", payload: { session_id: "s3", hook_event_name: "Stop" } }),
    ]);
  });

  test("新しい順に返る", () => {
    const got = listEvents(db, { includePayload: false, limit: 10 });
    expect(got.map((e) => e.eventId)).toEqual(["e4", "e3", "e2", "e1"]);
  });

  test("session で絞れる", () => {
    expect(listEvents(db, { sessionId: "s1", includePayload: false, limit: 10 })).toHaveLength(2);
  });

  test("machine で絞れる", () => {
    expect(listEvents(db, { machine: "m2", includePayload: false, limit: 10 })).toHaveLength(1);
  });

  test("同じ machine の別ユーザは混ざらない", () => {
    const got = listEvents(db, { machine: "m1", user: "dev", includePayload: false, limit: 10 });
    expect(got.map((e) => e.sessionId).sort()).toEqual(["s1", "s1"]);
  });

  test("hook 種別で絞れる", () => {
    expect(
      listEvents(db, { hookEventName: "SessionStart", includePayload: false, limit: 10 }),
    ).toHaveLength(1);
  });

  test("since は含み、until は含まない", () => {
    // e1..e4 の received_at_ms は 1001..1004
    const got = listEvents(db, { sinceMs: 1002, untilMs: 1004, includePayload: false, limit: 10 });
    expect(got.map((e) => e.receivedAtMs)).toEqual([1003, 1002]);
  });

  test("payload は既定で載らない", () => {
    expect(listEvents(db, { includePayload: false, limit: 1 })[0]!.payload).toBeNull();
    expect(listEvents(db, { includePayload: true, limit: 1 })[0]!.payload).not.toBeNull();
  });

  test("limit が効く", () => {
    expect(listEvents(db, { includePayload: false, limit: 2 })).toHaveLength(2);
  });
});

describe("listSessions", () => {
  test("event から session を導く。最後に観測した値が載る", () => {
    ingest(db, [
      ev({ receivedAtMs: 100, payload: { session_id: "s1", hook_event_name: "SessionStart", cwd: "/a" } }),
      ev({ receivedAtMs: 300, payload: { session_id: "s1", hook_event_name: "Stop", cwd: "/b" } }),
      ev({ receivedAtMs: 200, payload: { session_id: "s1", hook_event_name: "Stop", cwd: "/mid" } }),
    ]);
    const [s] = listSessions(db, { limit: 10 });
    expect(s).toMatchObject({
      machine: "m1",
      user: "dev",
      sessionId: "s1",
      firstSeenMs: 100,
      lastSeenMs: 300,
      eventCount: 3,
      // 最後に観測したもの。時系列の途中 (/mid) でも、最初 (/a) でもない
      cwd: "/b",
      lastHook: "Stop",
      endedAtMs: null,
    });
  });

  test("session_id が取れなかった event は session にならない", () => {
    ingest(db, [ev({ payload: { hook_event_name: "Stop" } }), ev({ payload: new Uint8Array([0xff]) })]);
    expect(listSessions(db, { limit: 10 })).toHaveLength(0);
  });

  test("同じ session_id でも machine と user が違えば別の session", () => {
    ingest(db, [
      ev({ machine: "m1", user: "dev", payload: { session_id: "same", hook_event_name: "Stop" } }),
      ev({ machine: "m2", user: "dev", payload: { session_id: "same", hook_event_name: "Stop" } }),
      ev({ machine: "m1", user: "other", payload: { session_id: "same", hook_event_name: "Stop" } }),
    ]);
    expect(listSessions(db, { limit: 10 })).toHaveLength(3);
  });

  test("SessionEnd を観測したら ended_at が入り、active_only から外れる", () => {
    ingest(db, [
      ev({ receivedAtMs: 100, payload: { session_id: "live", hook_event_name: "Stop" } }),
      ev({ receivedAtMs: 100, payload: { session_id: "over", hook_event_name: "Stop" } }),
      ev({ receivedAtMs: 200, payload: { session_id: "over", hook_event_name: "SessionEnd" } }),
    ]);
    expect(listSessions(db, { limit: 10 })).toHaveLength(2);

    const active = listSessions(db, { activeOnly: true, limit: 10 });
    expect(active.map((s) => s.sessionId)).toEqual(["live"]);

    const over = listSessions(db, { limit: 10 }).find((s) => s.sessionId === "over")!;
    expect(over.endedAtMs).toBe(200);
  });

  test("SessionEnd の後に event が来ても ended_at は消えない", () => {
    ingest(db, [
      ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "SessionEnd" } }),
      ev({ receivedAtMs: 200, payload: { session_id: "s", hook_event_name: "Stop" } }),
    ]);
    const [s] = listSessions(db, { limit: 10 });
    expect(s!.endedAtMs).toBe(100);
    expect(listSessions(db, { activeOnly: true, limit: 10 })).toHaveLength(0);
  });

  test("last_seen の新しい順に返り、limit が効く", () => {
    ingest(db, [
      ev({ receivedAtMs: 100, payload: { session_id: "old", hook_event_name: "Stop" } }),
      ev({ receivedAtMs: 300, payload: { session_id: "new", hook_event_name: "Stop" } }),
      ev({ receivedAtMs: 200, payload: { session_id: "mid", hook_event_name: "Stop" } }),
    ]);
    expect(listSessions(db, { limit: 10 }).map((s) => s.sessionId)).toEqual(["new", "mid", "old"]);
    expect(listSessions(db, { limit: 1 }).map((s) => s.sessionId)).toEqual(["new"]);
  });

  test("machine と user で絞れる", () => {
    ingest(db, [
      ev({ machine: "m1", user: "dev", payload: { session_id: "a", hook_event_name: "Stop" } }),
      ev({ machine: "m2", user: "dev", payload: { session_id: "b", hook_event_name: "Stop" } }),
      ev({ machine: "m1", user: "other", payload: { session_id: "c", hook_event_name: "Stop" } }),
    ]);
    expect(listSessions(db, { machine: "m1", limit: 10 }).map((s) => s.sessionId).sort()).toEqual(["a", "c"]);
    expect(listSessions(db, { machine: "m1", user: "dev", limit: 10 }).map((s) => s.sessionId)).toEqual(["a"]);
  });
});

describe("ingest は全か無か", () => {
  test("途中で落ちたら、その前に書いた分も残らない", () => {
    // CHUNK (500) を跨がせる。1 チャンク目は書けて、2 チャンク目で落ちる並び。
    // トランザクションが無ければ 1 チャンク目が残り、部分保存になる。
    const batch = Array.from({ length: 600 }, () => ev());
    batch[550] = { ...batch[550]!, eventId: "" };

    expect(() => ingest(db, batch)).toThrow();
    expect(listEvents(db, { includePayload: false, limit: 1000 })).toHaveLength(0);
  });

  test("同じ並びでも、壊れた 1 件が無ければ全件入る", () => {
    // 上のテストが「600 件は元々入らない」を見ているだけでないことの対照。
    expect(ingest(db, Array.from({ length: 600 }, () => ev()))).toBe(600);
  });
});

describe("payload は要求されたときだけ SELECT する", () => {
  test("includePayload が false なら payload 列を読まない", () => {
    ingest(db, [ev({ payload: { session_id: "s1", hook_event_name: "Stop" } })]);

    // 返り値の payload が null であることは「捨てた」も「読まなかった」も満たす。
    // 読んでいないことを見るには、SELECT の結果に列が居ないことを確かめる。
    const sql = listEventsQuery(db, { includePayload: false, limit: 1 }).toSQL().sql;
    expect(sql).not.toContain("payload");

    const withPayload = listEventsQuery(db, { includePayload: true, limit: 1 }).toSQL().sql;
    expect(withPayload).toContain("payload");
  });
});

describe("session state events (producer 2, #127)", () => {
  const hook = (sid: string, name = "PostToolUse") => ev({ payload: { session_id: sid, hook_event_name: name, cwd: "/w" } });
  const state = (sid: string, s: Record<string, unknown>, over: EvOverride = {}) =>
    ev({ producer: 2, payload: { session_id: sid, state: s }, ...over });

  test("the latest state per session rides on the row; state events do not count as hooks", () => {
    ingest(db, [hook("s1"), state("s1", { archived: false, label: "first", task: "" }), state("s1", { archived: true, label: "second", task: "kaneo ccx#1" }), hook("s2")]);
    const rows = listSessions(db, { limit: 10 });
    const s1 = rows.find((r) => r.sessionId === "s1")!;
    const s2 = rows.find((r) => r.sessionId === "s2")!;
    expect(s1.state).toEqual({ archived: true, label: "second", task: "kaneo ccx#1", metadata: {} });
    // hook の統計に state event は乗らない
    expect(s1.eventCount).toBe(1);
    expect(s1.lastHook).toBe("PostToolUse");
    // 1 件も届いていない session は null (「印が無い」ではなく「知らない」)
    expect(s2.state).toBeNull();
    // rev の無い event どうしは到着順。received_at (ccx-agent の時計) は見ない
    ingest(db, [state("s1", { archived: false, label: "later-but-older-clock", task: "" }, { receivedAtMs: 500, seq: 0 })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.label).toBe("later-but-older-clock");
  });

  test("metadata rides along as given; non-string values and keys core would refuse are dropped", () => {
    ingest(db, [hook("s1"), state("s1", { archived: false, label: "", task: "", metadata: { done: "", owner: "alice", n: 3, "../x": "", Done: "" } })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.metadata).toEqual({ done: "", owner: "alice" });
    ingest(db, [state("s1", { archived: false, metadata: ["x"] })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.metadata).toEqual({});
  });

  test("state events leave first_seen / last_seen / ended_at to the hooks", () => {
    ingest(db, [
      ev({ payload: { session_id: "s1", hook_event_name: "SessionStart", cwd: "/w" }, receivedAtMs: 1000 }),
      ev({ payload: { session_id: "s1", hook_event_name: "PostToolUse", cwd: "/w" }, receivedAtMs: 2000 }),
      // hook より前と後に届いた state。SessionEnd という名前を持たせても終了にはならない
      ev({ producer: 2, payload: { session_id: "s1", hook_event_name: "SessionEnd", state: { archived: true } }, receivedAtMs: 500 }),
      ev({ producer: 2, payload: { session_id: "s1", hook_event_name: "SessionEnd", state: { archived: true } }, receivedAtMs: 9000 }),
    ]);
    const s1 = listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!;
    expect([s1.firstSeenMs, s1.lastSeenMs, s1.endedAtMs, s1.eventCount]).toEqual([1000, 2000, null, 2]);
  });

  test("the sender's rev decides which state is latest, not arrival; ties fall back to arrival", () => {
    const withRev = (sid: string, label: string, rev: number) => ev({ producer: 2, payload: { session_id: sid, state: { archived: false, label, task: "" }, rev } });
    // B が後に書いて先に届き、A の古い写しが遅れて届く
    ingest(db, [hook("s1"), withRev("s1", "B-newer", 2000), withRev("s1", "A-older-arrived-late", 1000)]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.label).toBe("B-newer");
    // 同じ rev なら後から届いた方
    ingest(db, [withRev("s1", "same-ms-later", 2000)]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.label).toBe("same-ms-later");
  });

  test("the same session id on two origins keeps two states", () => {
    ingest(db, [
      hook("s1"),
      ev({ user: "other", payload: { session_id: "s1", hook_event_name: "PostToolUse", cwd: "/w" } }),
      state("s1", { archived: true, label: "mine", task: "" }),
      ev({ user: "other", producer: 2, payload: { session_id: "s1", state: { archived: false, label: "theirs", task: "" } } }),
    ]);
    const rows = listSessions(db, { limit: 10 }).filter((r) => r.sessionId === "s1");
    expect(Object.fromEntries(rows.map((r) => [r.user, r.state?.label]))).toEqual({ dev: "mine", other: "theirs" });
  });

  test("a session with only state events is not listed; an unreadable state payload counts as none", () => {
    ingest(db, [state("only", { archived: true, label: "", task: "" }), hook("s3"), state("s3", { archived: "yes", label: 1, task: "t" })]);
    const rows = listSessions(db, { limit: 10 });
    expect(rows.map((r) => r.sessionId)).toEqual(["s3"]);
    // 型の合わない値は落とす (truthy な文字列は true ではない)
    expect(rows[0]!.state).toEqual({ archived: false, label: "", task: "t", metadata: {} });
    // その session 宛ての読めない state が後から届いても、前の読める state が残る (墓標にならない)
    ingest(db, [ev({ producer: 2, payload: { session_id: "s3", state: "broken" } }), ev({ producer: 2, payload: { session_id: "s3", state: ["archived"] } })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s3")!.state).toEqual({ archived: false, label: "", task: "t", metadata: {} });
    // 読めない state しか無ければ null
    ingest(db, [hook("s4"), ev({ producer: 2, payload: { session_id: "s4", state: "broken" } })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s4")!.state).toBeNull();
    // 統計に数えるのは hook (producer 1) だけ。UNSPECIFIED (0) も hook ではない
    ingest(db, [ev({ producer: 0, payload: { session_id: "s5", hook_event_name: "X" } })]);
    expect(listSessions(db, { limit: 10 }).map((r) => r.sessionId)).not.toContain("s5");
  });
});
