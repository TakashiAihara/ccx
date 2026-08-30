import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openDb, type Db } from "./db/open.ts";
import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";
import { IngestRequestSchema, IngestService } from "@ccx/proto/ccx/v1/ingest_pb.ts";
import { createApp } from "./server.ts";

// 実際に HTTP で往復させる。handler を直接呼ぶと、Connect の枠組み (経路・
// content-type・エラーコードの写像) が一度も通らないまま「動いた」ことになる。
let server: ReturnType<typeof Bun.serve>;
let db: Db;
let ingestClient: ReturnType<typeof createClient<typeof IngestService>>;
let fleetClient: ReturnType<typeof createClient<typeof FleetService>>;

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

beforeEach(() => {
  db = openDb(":memory:");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db).fetch });
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${server.port}`,
    httpVersion: "1.1",
  });
  ingestClient = createClient(IngestService, transport);
  fleetClient = createClient(FleetService, transport);
});

afterEach(() => {
  void server.stop(true);
  db.$client.close();
});

let n = 0;
function event(payload: unknown, over: Record<string, unknown> = {}) {
  n += 1;
  return {
    eventId: `01a050b0-4c8c-7e7a-9e2b-00000000000${n}`,
    origin: { machine: "mcdev", user: "dev" },
    seq: BigInt(n),
    receivedAt: timestampFromMs(1_700_000_000_000 + n * 1000),
    producer: 1,
    payload: payload instanceof Uint8Array ? payload : enc(payload),
    ...over,
  };
}

async function send(...events: ReturnType<typeof event>[]) {
  return ingestClient.ingest(create(IngestRequestSchema, { events } as never));
}

describe("ccx-center over the wire", () => {
  beforeEach(() => {
    n = 0;
  });

  test("healthz", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
  });

  test("ccxd が送ったものが session として読み返せる", async () => {
    const res = await send(
      event({ session_id: "s1", hook_event_name: "SessionStart", cwd: "/repo" }),
      event({ session_id: "s1", hook_event_name: "Stop", cwd: "/repo" }),
    );
    expect(res.accepted).toBe(2);

    const { sessions } = await fleetClient.listSessions({});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.key).toMatchObject({ machine: "mcdev", user: "dev", sessionId: "s1" });
    expect(sessions[0]!.eventCount).toBe(2n);
    expect(sessions[0]!.lastHook).toBe("Stop");
    expect(sessions[0]!.cwd).toBe("/repo");
    expect(sessions[0]!.endedAt).toBeUndefined();
  });

  test("同じ event を二度送っても増えない (at-least-once 転送)", async () => {
    const e = event({ session_id: "s1", hook_event_name: "Stop" });
    expect((await send(e)).accepted).toBe(1);
    expect((await send(e)).accepted).toBe(0);

    const { events } = await fleetClient.listEvents({});
    expect(events).toHaveLength(1);
  });

  test("session / machine / hook 種別 / 時刻で引ける", async () => {
    await send(
      event({ session_id: "s1", hook_event_name: "SessionStart" }),
      event({ session_id: "s1", hook_event_name: "Stop" }),
      event({ session_id: "s2", hook_event_name: "Stop" }, { origin: { machine: "d1", user: "dev" } }),
    );

    expect((await fleetClient.listEvents({ sessionId: "s1" })).events).toHaveLength(2);
    expect((await fleetClient.listEvents({ machine: "d1" })).events).toHaveLength(1);
    expect((await fleetClient.listEvents({ hookEventName: "Stop" })).events).toHaveLength(2);
    expect(
      (await fleetClient.listEvents({ since: timestampFromMs(1_700_000_002_000) })).events,
    ).toHaveLength(2);
  });

  test("payload は明示したときだけ返る", async () => {
    await send(event({ session_id: "s1", hook_event_name: "Stop" }));

    const without = await fleetClient.listEvents({});
    expect(without.events[0]!.payload).toHaveLength(0);

    const withPayload = await fleetClient.listEvents({ includePayload: true });
    const text = new TextDecoder().decode(withPayload.events[0]!.payload);
    expect(JSON.parse(text)).toMatchObject({ session_id: "s1" });
  });

  test("読めなかった payload も event として返り、parsed=false が付く", async () => {
    await send(event(new Uint8Array([0xff, 0xfe])));
    const { events } = await fleetClient.listEvents({});
    expect(events).toHaveLength(1);
    expect(events[0]!.parsed).toBe(false);
    // session にはならない (session_id が導出できないので)
    expect((await fleetClient.listSessions({})).sessions).toHaveLength(0);
  });

  test("active_only は SessionEnd を観測していないものだけ返す", async () => {
    await send(
      event({ session_id: "live", hook_event_name: "Stop" }),
      event({ session_id: "over", hook_event_name: "Stop" }),
      event({ session_id: "over", hook_event_name: "SessionEnd" }),
    );
    const active = await fleetClient.listSessions({ activeOnly: true });
    expect(active.sessions.map((s) => s.key!.sessionId)).toEqual(["live"]);
  });

  // ここが見ているのは「入口で弾く」ところまで。検証は insert より手前で走るので、
  // トランザクションが外れてもこのテストは通る。DB の巻き戻しは store.test.ts の
  // 「ingest は全か無か」が、チャンクを跨いで途中で落ちるバッチで pin している
  test("event_id が無いバッチは入口で弾かれ、1 件も保存されない", async () => {
    const err = await send(
      event({ session_id: "ok", hook_event_name: "Stop" }),
      event({ session_id: "bad", hook_event_name: "Stop" }, { eventId: "" }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    // 先頭の 1 件も入っていないこと。部分的に保存して成功を返さない
    expect((await fleetClient.listEvents({})).events).toHaveLength(0);
  });

  test("origin が欠けたバッチも同じく全部落ちる", async () => {
    const err = await send(
      event({ session_id: "ok", hook_event_name: "Stop" }, { origin: { machine: "", user: "" } }),
    ).catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    expect((await fleetClient.listEvents({})).events).toHaveLength(0);
  });

  test("limit は既定 100 / 上限 1000 に丸められる", async () => {
    await send(...Array.from({ length: 3 }, (_, i) => event({ session_id: `s${i}`, hook_event_name: "Stop" })));
    expect((await fleetClient.listEvents({ limit: 2 })).events).toHaveLength(2);
    // 上限を超える指定でもエラーにはせず丸める
    expect((await fleetClient.listEvents({ limit: 99_999 })).events).toHaveLength(3);
  });
});
