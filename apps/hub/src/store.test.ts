import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

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

  test("別のバッチで古い event が後から届いても、最後に観測した値と集計は変わらない (#307)", () => {
    ingest(db, [ev({ receivedAtMs: 300, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/new", transcript_path: "/t/new" } })]);
    ingest(db, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "SessionStart", cwd: "/old", transcript_path: "/t/old" } })]);
    ingest(db, [ev({ receivedAtMs: 200, payload: { session_id: "s", hook_event_name: "SessionEnd", cwd: "/mid" } })]);
    ingest(db, [ev({ receivedAtMs: 150, payload: { session_id: "s", hook_event_name: "SessionEnd", cwd: "/early" } })]);
    expect(listSessions(db, { limit: 10 })[0]).toMatchObject({
      firstSeenMs: 100,
      lastSeenMs: 300,
      eventCount: 4,
      endedAtMs: 200,
      cwd: "/new",
      transcriptPath: "/t/new",
      lastHook: "Stop",
    });
  });

  test("seq は最後の event のもので比べる。前の event の seq が大きくても引きずらない", () => {
    ingest(db, [ev({ receivedAtMs: 100, seq: 9, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/t100" } })]);
    ingest(db, [ev({ receivedAtMs: 300, seq: 7, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/seq7" } })]);
    ingest(db, [ev({ receivedAtMs: 300, seq: 8, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/seq8" } })]);
    expect(listSessions(db, { limit: 1 })[0]!.cwd).toBe("/seq8");
  });

  test("新しい event の後に古い event が来ても、比べる seq は新しい方のまま (#340)", () => {
    ingest(db, [ev({ receivedAtMs: 300, seq: 7, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/seq7" } })]);
    ingest(db, [ev({ receivedAtMs: 100, seq: 9, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/old" } })]);
    ingest(db, [ev({ receivedAtMs: 300, seq: 8, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/seq8" } })]);
    expect(listSessions(db, { limit: 1 })[0]!.cwd).toBe("/seq8");
  });

  test("SessionEnd が古い順に届いても ended_at は最も遅いもの", () => {
    ingest(db, [ev({ receivedAtMs: 150, payload: { session_id: "s", hook_event_name: "SessionEnd" } })]);
    ingest(db, [ev({ receivedAtMs: 200, payload: { session_id: "s", hook_event_name: "SessionEnd" } })]);
    expect(listSessions(db, { limit: 1 })[0]!.endedAtMs).toBe(200);
  });

  test("received_at が同じなら seq の大きい event の値が載る", () => {
    ingest(db, [ev({ receivedAtMs: 100, seq: 7, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/seq7" } })]);
    ingest(db, [ev({ receivedAtMs: 100, seq: 9, payload: { session_id: "s", hook_event_name: "Notification", cwd: "/seq9" } })]);
    ingest(db, [ev({ receivedAtMs: 100, seq: 8, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/seq8" } })]);
    expect(listSessions(db, { limit: 10 })[0]).toMatchObject({ cwd: "/seq9", lastHook: "Notification", eventCount: 3 });
  });

  test("hook 以外の producer の event は集計に入らない", () => {
    ingest(db, [ev({ producer: 2, payload: { session_id: "s", hook_event_name: "Stop" } })]);
    expect(listSessions(db, { limit: 10 })).toHaveLength(0);
  });

  test("集計表が無ければ、開くときに events から作る。在れば作り直さない (#307)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-summary-"));
    try {
      const path = join(dir, "center.db");
      const a = openDb(path);
      ingest(a, [
        // received_at と seq の並びが逆になる組で、received_at が先に効くことを見る
        ev({ receivedAtMs: 100, seq: 9, payload: { session_id: "s", hook_event_name: "SessionStart", cwd: "/a", transcript_path: "/t/a" } }),
        ev({ receivedAtMs: 250, seq: 2, payload: { session_id: "s", hook_event_name: "SessionEnd", cwd: "/end1" } }),
        ev({ receivedAtMs: 300, seq: 7, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/c", transcript_path: "/t/c" } }),
        ev({ receivedAtMs: 200, seq: 5, payload: { session_id: "s", hook_event_name: "SessionEnd", cwd: "/end0" } }),
        ev({ machine: "m2", receivedAtMs: 220, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/m2" } }),
        ev({ receivedAtMs: 210, payload: { session_id: "t", hook_event_name: "Stop" } }),
        // received_at が同じで seq だけ違う組。seq の大きい方
        ev({ user: "other", receivedAtMs: 215, seq: 3, payload: { session_id: "t", hook_event_name: "Stop", cwd: "/seq3" } }),
        ev({ user: "other", receivedAtMs: 215, seq: 6, payload: { session_id: "t", hook_event_name: "Stop", cwd: "/seq6" } }),
        ev({ user: "other", receivedAtMs: 215, seq: 4, payload: { session_id: "t", hook_event_name: "Stop", cwd: "/seq4" } }),
        // 完全に同じ (received_at, seq) は先に入った方
        ev({ receivedAtMs: 205, seq: 4, payload: { session_id: "tie", hook_event_name: "Stop", cwd: "/first" } }),
        ev({ receivedAtMs: 205, seq: 4, payload: { session_id: "tie", hook_event_name: "Notification", cwd: "/second" } }),
        ev({ receivedAtMs: 999, payload: { hook_event_name: "Stop" } }),
        ev({ producer: 2, receivedAtMs: 998, payload: { session_id: "u", hook_event_name: "Stop" } }),
      ]);
      const before = listSessions(a, { limit: 10, nowMs: 0 });
      expect(before.map((s) => `${s.machine}/${s.user}/${s.sessionId}`)).toEqual(["m1/dev/s", "m2/dev/s", "m1/other/t", "m1/dev/t", "m1/dev/tie"]);
      expect(before[2]).toMatchObject({ cwd: "/seq6", eventCount: 3 });
      expect(before[0]).toMatchObject({ firstSeenMs: 100, lastSeenMs: 300, endedAtMs: 250, eventCount: 4, cwd: "/c", transcriptPath: "/t/c", lastHook: "Stop" });
      expect(before[4]).toMatchObject({ cwd: "/first", lastHook: "Stop", eventCount: 2 });
      a.$client.exec("DROP TABLE session_summary");
      a.$client.close();

      const b = openDb(path);
      expect(listSessions(b, { limit: 10, nowMs: 0 })).toEqual(before);
      // 作り直した行の last_seq も効く。同じ received_at で seq の小さい event は値を動かさない
      ingest(b, [ev({ receivedAtMs: 300, seq: 3, payload: { session_id: "s", hook_event_name: "Notification", cwd: "/older" } })]);
      expect(listSessions(b, { limit: 1, nowMs: 0 })[0]).toMatchObject({ cwd: "/c", eventCount: 5 });
      // 作り直した last_seq は最後の event の 7 (最大の 9 ではない)。8 なら置き換わる
      ingest(b, [ev({ receivedAtMs: 300, seq: 8, payload: { session_id: "s", hook_event_name: "Notification", cwd: "/seq8" } })]);
      expect(listSessions(b, { limit: 1, nowMs: 0 })[0]).toMatchObject({ cwd: "/seq8", eventCount: 6 });
      b.$client.close();

      // 在る表は空でも作り直さない。空かどうかで決めると、hook の event が無い DB で起動のたびに全件を読む
      const c = openDb(path);
      expect(listSessions(c, { limit: 1, nowMs: 0 })[0]).toMatchObject({ cwd: "/seq8", eventCount: 6 });
      c.$client.exec("DELETE FROM session_summary");
      c.$client.close();
      const d = openDb(path);
      expect(listSessions(d, { limit: 10, nowMs: 0 })).toEqual([]);
      d.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("新しい event が来れば transcript_path も置き換わる", () => {
    ingest(db, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop", transcript_path: "/t/old" } })]);
    ingest(db, [ev({ receivedAtMs: 200, payload: { session_id: "s", hook_event_name: "Stop", transcript_path: "/t/new" } })]);
    expect(listSessions(db, { limit: 1 })[0]!.transcriptPath).toBe("/t/new");
  });

  test("保存済みの event_id が再送されても件数は増えない", () => {
    const e = ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop" } });
    ingest(db, [e]);
    ingest(db, [e, ev({ receivedAtMs: 50, payload: { session_id: "s", hook_event_name: "Stop" } })]);
    expect(listSessions(db, { limit: 1 })[0]).toMatchObject({ eventCount: 2, firstSeenMs: 50 });
  });

  test("同じバッチに同じ event_id が 2 つあれば、保存された先の行で集計する", () => {
    const a = ev({ payload: { session_id: "first", hook_event_name: "Stop" } });
    ingest(db, [a, { ...ev({ payload: { session_id: "second", hook_event_name: "Stop" } }), eventId: a.eventId }]);
    expect(listEvents(db, { includePayload: false, limit: 10 }).map((e) => e.sessionId)).toEqual(["first"]);
    expect(listSessions(db, { limit: 10 }).map((s) => s.sessionId)).toEqual(["first"]);
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
    ingest(db, [hook("s1"), state("s1", { archived: false, label: "first", task: "" }), state("s1", { archived: true, label: "second", task: "kaneo ccx#1", role: "worker" }), hook("s2")]);
    const rows = listSessions(db, { limit: 10 });
    const s1 = rows.find((r) => r.sessionId === "s1")!;
    const s2 = rows.find((r) => r.sessionId === "s2")!;
    expect(s1.state).toEqual({ archived: true, label: "second", task: "kaneo ccx#1", role: "worker", metadata: {} });
    // hook の統計に state event は乗らない
    expect(s1.eventCount).toBe(1);
    expect(s1.lastHook).toBe("PostToolUse");
    // 1 件も届いていない session は null (「印が無い」ではなく「知らない」)
    expect(s2.state).toBeNull();
    // rev の無い event どうしは到着順。received_at (ccx-agent の時計) は見ない
    ingest(db, [state("s1", { archived: false, label: "later-but-older-clock", task: "" }, { receivedAtMs: 500, seq: 0 })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.label).toBe("later-but-older-clock");
  });

  test("a role that is not one line is held as none, as core reads it (packages/core/testdata/role-cases.json)", async () => {
    const { rule } = (await Bun.file(join(import.meta.dir, "../../../packages/core/testdata/role-cases.json")).json()) as { rule: { value: string; valid: boolean }[] };
    for (const { value, valid } of rule) {
      ingest(db, [hook("s1"), state("s1", { archived: false, label: "", task: "", role: value })]);
      expect([value, listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s1")!.state?.role]).toEqual([value, valid ? value : ""]);
    }
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
    expect(rows[0]!.state).toEqual({ archived: false, label: "", task: "t", role: "", metadata: {} });
    // その session 宛ての読めない state が後から届いても、前の読める state が残る (墓標にならない)
    ingest(db, [ev({ producer: 2, payload: { session_id: "s3", state: "broken" } }), ev({ producer: 2, payload: { session_id: "s3", state: ["archived"] } })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s3")!.state).toEqual({ archived: false, label: "", task: "t", role: "", metadata: {} });
    // 読めない state しか無ければ null
    ingest(db, [hook("s4"), ev({ producer: 2, payload: { session_id: "s4", state: "broken" } })]);
    expect(listSessions(db, { limit: 10 }).find((r) => r.sessionId === "s4")!.state).toBeNull();
    // 統計に数えるのは hook (producer 1) だけ。UNSPECIFIED (0) も hook ではない
    ingest(db, [ev({ producer: 0, payload: { session_id: "s5", hook_event_name: "X" } })]);
    expect(listSessions(db, { limit: 10 }).map((r) => r.sessionId)).not.toContain("s5");
  });
});

describe("ccx-agent の回収の記録 (PRODUCER_CCX_AGENT_REAPED、docs/design/reap.md)", () => {
  test("events に session 付きで積まれ、hook としては数えない", () => {
    const reaped = { session_id: "s", reaped: { at: "2026-11-22T00:00:00Z", reason: "expired", pid: 100, pssBytes: 1, start: 5, boot: "b" } };
    expect(ingest(db, [ev({ producer: Producer.CCX_AGENT_REAPED, payload: reaped })])).toBe(1);
    const got = listEvents(db, { includePayload: false, limit: 10, sessionId: "s" });
    expect(got.map((e) => e.producer)).toEqual([Producer.CCX_AGENT_REAPED]);
    // セッションの一覧 (hook の統計) には出ない
    expect(listSessions(db, { limit: 10 }).map((r) => r.sessionId)).not.toContain("s");
  });
});

describe("listSessions の宣言状態の引き方 (#307)", () => {
  test("session ごとの宣言状態は宣言状態だけの部分 index で引き、hook の event をたどらない", () => {
    ingest(db, [
      ev({ payload: { session_id: "s", hook_event_name: "Stop" } }),
      ev({ producer: Producer.CCX_SESSION_STATE, payload: { session_id: "s", state: { archived: true } } }),
    ]);

    // listSessions が実際に出す SQL を捕まえて、その計画を見る
    const seen: string[] = [];
    const prepare = db.$client.prepare.bind(db.$client);
    db.$client.prepare = ((q: string) => {
      seen.push(q);
      return prepare(q);
    }) as typeof db.$client.prepare;
    try {
      expect(listSessions(db, { limit: 10 })[0]!.state?.archived).toBe(true);
    } finally {
      db.$client.prepare = prepare;
    }

    const stateSql = seen.filter((q) => q.includes("json_extract(doc, '$.rev')"));
    expect(stateSql).toHaveLength(1);
    const plan = (db.$client.query(`EXPLAIN QUERY PLAN ${stateSql[0]}`).all("m1", "dev", "s") as { detail: string }[]).map((p) => p.detail).join("\n");
    const seek = plan.match(/events USING INDEX events_state_session_idx \(([^)]*)\)/)?.[1] ?? "";
    expect(seek.split(" AND ").sort()).toEqual(["machine=?", "os_user=?", "session_id=?"]);
    expect(plan).not.toContain("events USING INDEX events_session_idx");
  });

  test("宣言状態の index は宣言状態の行だけを持つ部分 index (#340)", () => {
    // 部分 index は条件の合わない問い合わせ (hook の event を数える集計表の作り直し) に選ばれない
    const idx = db.$client.query("PRAGMA index_list(events)").all() as { name: string; partial: number }[];
    expect(idx.find((i) => i.name === "events_state_session_idx")?.partial).toBe(1);
    const def = db.$client.query("SELECT sql FROM sqlite_master WHERE name = 'events_state_session_idx'").get() as { sql: string };
    expect(def.sql).toContain(`WHERE producer = ${Producer.CCX_SESSION_STATE}`);
  });
});

describe("集計表と events の食い違いを起動時に直す (#340)", () => {
  const listed = (d: Db) => listSessions(d, { limit: 10, nowMs: 0 }).map((s) => `${s.sessionId}:${s.eventCount}:${s.cwd}`);

  function withFile(fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "ccx-mark-"));
    try {
      fn(join(dir, "center.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("ingest を通らずに入った event (戻した古い版が書いた分) は、次に開いたときにその session ごと数え直す", () => {
    withFile((path) => {
      const a = openDb(path);
      ingest(a, [
        ev({ receivedAtMs: 100, seq: 1, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/a" } }),
        ev({ receivedAtMs: 50, seq: 1, payload: { session_id: "keep", hook_event_name: "Stop", cwd: "/keep" } }),
      ]);
      // 古い版の center は集計表も目印も知らずに events だけへ書く
      const raw = a.$client.prepare(
        "INSERT INTO events (event_id, machine, os_user, seq, received_at_ms, producer, payload, parsed, session_id, hook_event_name, cwd, transcript_path) VALUES (?, 'm1', 'dev', ?, ?, 1, x'7b7d', 1, ?, 'Stop', ?, '')",
      );
      raw.run("old-1", 2, 300, "s", "/old-late");
      raw.run("old-2", 3, 200, "s", "/old-mid");
      raw.run("old-3", 4, 150, "t", "/t");
      raw.run("old-4", 5, 400, "", "/no-session");
      // 完全に同じ (received_at, seq) は先に入った方 (ingest と作り直しと同じ)
      raw.run("old-5", 6, 120, "u", "/first");
      raw.run("old-6", 6, 120, "u", "/second");
      a.$client.run("INSERT INTO events (event_id, machine, os_user, seq, received_at_ms, producer, payload, parsed, session_id, hook_event_name, cwd, transcript_path) VALUES ('old-7', 'm1', 'dev', 7, 900, 2, x'7b7d', 1, 'st', '', '/state', '')");
      expect(listed(a)).toEqual(["s:1:/a", "keep:1:/keep"]);
      a.$client.close();

      const b = openDb(path);
      expect(listed(b)).toEqual(["s:3:/old-late", "t:1:/t", "u:2:/first", "keep:1:/keep"]);
      b.$client.close();

      // もう一度開いても同じ (目印が末尾まで進んでいるので作り直しは走らない)
      const c = openDb(path);
      expect(listed(c)).toEqual(["s:3:/old-late", "t:1:/t", "u:2:/first", "keep:1:/keep"]);
      c.$client.close();
    });
  });

  test("集計表を足すが目印を知らない版 (#335〜#346) に戻して上げ直しても、件数を二重に数えない", () => {
    withFile((path) => {
      const a = openDb(path);
      ingest(a, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/a" } })]);
      const before = a.$client.query("SELECT last_event_rowid AS n FROM session_summary_mark").get() as { n: number };
      // その版の ingest: 集計表は足すが目印は進めない
      ingest(a, [ev({ receivedAtMs: 200, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/b" } })]);
      a.$client.run("UPDATE session_summary_mark SET last_event_rowid = ?", [before.n]);
      expect(listed(a)).toEqual(["s:2:/b"]);
      a.$client.close();

      const b = openDb(path);
      expect(listed(b)).toEqual(["s:2:/b"]);
      b.$client.close();
    });
  });

  test("目印の後に他の版が書いた行があれば、ingest は目印を進めず、次に開いたときに数える", () => {
    withFile((path) => {
      const a = openDb(path);
      ingest(a, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/a" } })]);
      a.$client.run(
        "INSERT INTO events (event_id, machine, os_user, seq, received_at_ms, producer, payload, parsed, session_id, hook_event_name, cwd, transcript_path) VALUES ('foreign', 'm1', 'dev', 50, 150, 1, x'7b7d', 1, 'f', 'Stop', '/foreign', '')",
      );
      ingest(a, [ev({ receivedAtMs: 300, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/c" } })]);
      expect(listed(a)).toEqual(["s:2:/c"]);
      a.$client.close();

      const b = openDb(path);
      expect(listed(b)).toEqual(["s:2:/c", "f:1:/foreign"]);
      b.$client.close();
    });
  });

  test("目印の行が無ければ集計表を events から作り直す (#307 の表だけがある DB / 手で消したとき)", () => {
    withFile((path) => {
      const a = openDb(path);
      ingest(a, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/a" } })]);
      a.$client.exec("UPDATE session_summary SET event_count = 99, cwd = '/stale'");
      a.$client.exec("DELETE FROM session_summary_mark");
      a.$client.close();

      const b = openDb(path);
      expect(listed(b)).toEqual(["s:1:/a"]);
      b.$client.close();
    });
  });

  test("ingest は目印を events の末尾まで進め、次に開いたときに作り直す行を残さない", () => {
    withFile((path) => {
      const a = openDb(path);
      ingest(a, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/a" } }), ev({ receivedAtMs: 200, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/b" } })]);
      // ingest が目印を末尾まで進めている (進めないと起動のたびに目印から後を全部作り直す)
      expect(a.$client.query("SELECT last_event_rowid AS n FROM session_summary_mark").get()).toEqual({ n: 2 });
      a.$client.close();

      const b = openDb(path);
      expect(listed(b)).toEqual(["s:2:/b"]);
      b.$client.close();
    });
  });
});

describe("ingest と他プロセスの書き込みが重なったとき (#340)", () => {
  test("他プロセスが書き込みロックを持っていれば ingest は待ち、その行の後に入って目印を進めない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccx-immediate-"));
    try {
      const path = join(dir, "center.db");
      const db = openDb(path);
      ingest(db, [ev({ receivedAtMs: 100, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/a" } })]);

      const ready = join(dir, "ready");
      const foreign =
        "INSERT INTO events (event_id, machine, os_user, seq, received_at_ms, producer, payload, parsed, session_id, hook_event_name, cwd, transcript_path) VALUES ('foreign', 'm1', 'dev', 50, 150, 1, x'7b7d', 1, 'f', 'Stop', '/foreign', '')";
      const holder = Bun.spawn(["bun", "run", join(import.meta.dir, "db", "lock-holder.ts"), path, ready, "1500", foreign], { stdout: "ignore", stderr: "ignore" });
      try {
        for (let i = 0; i < 100 && !(await Bun.file(ready).exists()); i += 1) await Bun.sleep(20);
        expect(await Bun.file(ready).exists()).toBe(true);

        // ロックの中に入ったことを、離した印がまだ無いことで確かめる。無ければ deferred でも immediate でも同じ結果になり、
        // この検査に判別能力が無い (そのときはテストを落として知らせる)
        expect(await Bun.file(`${ready}.done`).exists()).toBe(false);
        // 目印を読む SELECT を書き込みロックより先にすると、ロックの解放後に SQLITE_BUSY_SNAPSHOT で落ちる
        expect(ingest(db, [ev({ receivedAtMs: 300, payload: { session_id: "s", hook_event_name: "Stop", cwd: "/c" } })])).toBe(1);
        for (let i = 0; i < 100 && !(await Bun.file(`${ready}.done`).exists()); i += 1) await Bun.sleep(20);
        expect(await Bun.file(`${ready}.done`).exists()).toBe(true);

        const mark = db.$client.query("SELECT last_event_rowid AS n FROM session_summary_mark").get() as { n: number };
        expect(mark.n).toBe(1);
      } finally {
        holder.kill();
        await holder.exited;
        db.$client.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
