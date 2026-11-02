/**
 * 起こしの合図 (#261, D-11 / D-12)。ccx-agent が実行中一覧に api_url を載せていて、center に agent 用の token
 * (CCX_CENTER_AGENT_TOKEN) があれば、新しい再開依頼を置いたときに center がその agent の AgentService.Wake を叩く。
 * 合図は依頼を運ばず、届かなくても依頼の置き方は変わらない (agent の polling が拾う)。
 *
 * agent の側は本物の HTTP の偽物で受け、center が実際に何を送ったかを見る。
 */

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResumeService } from "@ccx/proto/ccx/v1/resume_pb.ts";

import { openDb, type Db } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { createApp } from "./server.ts";
import { ingest, RUNNING_FRESH_MS, type IncomingEvent } from "./store.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_TOKEN = "agent-token-for-tests-0123456789";
const T0 = 1_800_000_000_000;

type Hit = { path: string; auth: string | null; method: string };

let db: Db;
let objectsDir: string;
let now = T0;
let center: ReturnType<typeof Bun.serve> | undefined;
let agent: ReturnType<typeof Bun.serve> | undefined;
let hits: Hit[];
let agentDelayMs = 0;
let n = 0;

beforeEach(async () => {
  now = T0;
  n = 0;
  hits = [];
  agentDelayMs = 0;
  db = openDb(":memory:");
  objectsDir = await mkdtemp(join(tmpdir(), "ccx-wake-objects-"));
  agent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), method: req.method });
      if (agentDelayMs) await Bun.sleep(agentDelayMs);
      return Response.json({});
    },
  });
});

afterEach(async () => {
  void center?.stop(true);
  void agent?.stop(true);
  center = undefined;
  agent = undefined;
  db.$client.close();
  await rm(objectsDir, { recursive: true, force: true });
});

function startCenter(agentToken?: string) {
  center = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApp(db, new ObjectStore(objectsDir), { now: () => now, agentToken }).fetch,
  });
  return createClient(ResumeService, createConnectTransport({ baseUrl: `http://127.0.0.1:${center.port}`, httpVersion: "1.1" }));
}

function running(body: Record<string, unknown>, machine = "m1"): IncomingEvent {
  n += 1;
  return {
    eventId: `r${n}`,
    machine,
    user: "dev",
    seq: n,
    receivedAtMs: now,
    producer: 3,
    payload: new TextEncoder().encode(JSON.stringify(body)),
  };
}

const agentUrl = () => `http://127.0.0.1:${agent!.port}`;
const key = (sessionId = A, machine = "m1") => ({ machine, user: "dev", sessionId });

async function hitsAfter(ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end && hits.length === 0) await Bun.sleep(10);
  // 遅れて 2 本目が来ないことも見るので、来た後も少し待つ
  await Bun.sleep(100);
  return hits;
}

test("a new request wakes the agent at its api_url with the agent token", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  await client.requestResume({ key: key() });
  expect(await hitsAfter()).toEqual([{ path: "/ccx.v1.AgentService/Wake", auth: `Bearer ${AGENT_TOKEN}`, method: "POST" }]);
});

test("putting the same request again does not wake the agent again", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  await client.requestResume({ key: key() });
  await hitsAfter();
  hits = [];
  await client.requestResume({ key: key() });
  expect(await hitsAfter(300)).toEqual([]);
});

test("only the machine the request is for is woken", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() }, "m2")], now);
  await client.requestResume({ key: key(A, "m1") });
  expect(await hitsAfter(300)).toEqual([]);
  await client.requestResume({ key: key(A, "m2") });
  expect((await hitsAfter()).map((h) => h.path)).toEqual(["/ccx.v1.AgentService/Wake"]);
});

test("an api_url inside the freshness window is still used after time passes", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  now += RUNNING_FRESH_MS;
  await client.requestResume({ key: key() });
  expect((await hitsAfter()).map((h) => h.path)).toEqual(["/ccx.v1.AgentService/Wake"]);
});

test("an api_url with a path, query, fragment or userinfo is not kept", async () => {
  startCenter(AGENT_TOKEN);
  const kept = () => db.$client.query("SELECT api_url FROM agent_endpoints").all();
  for (const bad of [`${agentUrl()}/evil`, `${agentUrl()}?q=`, `${agentUrl()}#f`, agentUrl().replace("http://", "http://u:p@")]) {
    ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
    ingest(db, [running({ session_ids: [], api_url: bad })], now);
    expect(kept()).toEqual([]);
  }
  // 末尾の / だけは origin と同じ
  ingest(db, [running({ session_ids: [], api_url: `${agentUrl()}/` })], now);
  expect(kept()).toEqual([{ api_url: agentUrl() }]);
});

test("the center does not follow a redirect from the agent's address", async () => {
  const elsewhere: string[] = [];
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      elsewhere.push(new URL(req.url).pathname);
      return Response.json({});
    },
  });
  void agent!.stop(true);
  agent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), method: req.method });
      return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/internal` } });
    },
  });
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  await client.requestResume({ key: key() });
  await hitsAfter();
  await Bun.sleep(200);
  void other.stop(true);
  expect(hits).toHaveLength(1);
  expect(elsewhere).toEqual([]);
});

/** Replaces the fake agent with one that answers every request with respond() */
function agentAnswering(respond: () => Response) {
  void agent!.stop(true);
  agent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      hits.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), method: req.method });
      return respond();
    },
  });
}

/** Collects console.error lines until the returned stop() is called */
function errorLines() {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, stop: () => spy.mockRestore() };
}

async function linesAfter(lines: string[], ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end && lines.length === 0) await Bun.sleep(10);
  // A second line logged late is a failure too, so wait a little after the first
  await Bun.sleep(100);
  return lines;
}

test("a redirect from the agent is logged as not followed, with the URL it was sent to", async () => {
  agentAnswering(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/x" } }));
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  const log = errorLines();
  try {
    await client.requestResume({ key: key() });
    expect(await linesAfter(log.lines)).toEqual([
      `wake m1: agent at ${agentUrl()}/ccx.v1.AgentService/Wake answered 302; a redirect is not followed`,
    ]);
  } finally {
    log.stop();
  }
});

test("an error status from the agent is logged with the status", async () => {
  agentAnswering(() => new Response("no", { status: 503 }));
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  const log = errorLines();
  try {
    await client.requestResume({ key: key() });
    expect(await linesAfter(log.lines)).toEqual([`wake m1: agent at ${agentUrl()}/ccx.v1.AgentService/Wake answered 503`]);
  } finally {
    log.stop();
  }
});

test("a successful wake logs nothing", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  const log = errorLines();
  try {
    await client.requestResume({ key: key() });
    expect(await hitsAfter()).toHaveLength(1);
    await Bun.sleep(100);
    expect(log.lines).toEqual([]);
  } finally {
    log.stop();
  }
});

test("the center drops the agent's answer body instead of leaving it open", async () => {
  // A body that never ends, so only a cancel closes it. Left unread, Bun also closes it once the
  // Response is garbage collected; the test holds every Response the center gets so that cannot happen
  const held: Response[] = [];
  const realFetch = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (...args: Parameters<typeof fetch>) => {
    const res = await realFetch(...args);
    held.push(res);
    return res;
  }) as typeof fetch);
  let answeredAt = 0;
  let cancelledAt = 0;
  agentAnswering(() => {
    answeredAt = Date.now();
    return new Response(
      new ReadableStream({
        pull: async (c) => {
          c.enqueue(new TextEncoder().encode("x".repeat(1024)));
          await Bun.sleep(20);
        },
        cancel: () => {
          cancelledAt = Date.now();
        },
      }),
    );
  });
  try {
    const client = startCenter(AGENT_TOKEN);
    ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
    await client.requestResume({ key: key() });
    // Below the wake's 3 s timeout, which would also end the body
    const end = Date.now() + 1500;
    while (Date.now() < end && !cancelledAt) await Bun.sleep(5);
    expect(hits).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(cancelledAt).toBeGreaterThan(0);
    expect(cancelledAt - answeredAt).toBeLessThan(500);
  } finally {
    spy.mockRestore();
  }
});

test("without an agent token the center wakes no one", async () => {
  const client = startCenter(undefined);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  await client.requestResume({ key: key() });
  expect(await hitsAfter(300)).toEqual([]);
});

test("an agent that sent no api_url is not woken", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [] })], now);
  await client.requestResume({ key: key() });
  expect(await hitsAfter(300)).toEqual([]);
});

test("a later list without api_url forgets the earlier one", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  ingest(db, [running({ session_ids: [] })], now);
  await client.requestResume({ key: key() });
  expect(await hitsAfter(300)).toEqual([]);
});

test("an api_url from a list older than the freshness window is not used", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  now += RUNNING_FRESH_MS + 1;
  await client.requestResume({ key: key() });
  expect(await hitsAfter(300)).toEqual([]);
});

test("an api_url that is not an absolute http(s) URL is not kept", async () => {
  startCenter(AGENT_TOKEN);
  const kept = () => db.$client.query("SELECT api_url FROM agent_endpoints").all();
  for (const bad of ["ftp://127.0.0.1/x", "127.0.0.1:1", "not a url", "http://", 42]) {
    // 先に正しい URL を入れておき、不正な値がそれを置き換えずに消すことを見る
    ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
    expect(kept()).toEqual([{ api_url: agentUrl() }]);
    ingest(db, [running({ session_ids: [], api_url: bad })], now);
    expect(kept()).toEqual([]);
  }
});

test("a slow agent does not hold up placing the request", async () => {
  agentDelayMs = 5000;
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  const t = Date.now();
  const { request } = await client.requestResume({ key: key() });
  expect(Date.now() - t).toBeLessThan(1000);
  expect(request?.id).toBeTruthy();
});

test("an agent that cannot be reached does not fail the request", async () => {
  const client = startCenter(AGENT_TOKEN);
  // 誰も聞いていないポート (偽の agent を止めた後のもの)
  const url = agentUrl();
  void agent!.stop(true);
  agent = undefined;
  ingest(db, [running({ session_ids: [], api_url: url })], now);
  const { request } = await client.requestResume({ key: key() });
  expect(request?.id).toBeTruthy();
});

test("a failure while looking up the address does not fail the request that was already stored", async () => {
  const client = startCenter(AGENT_TOKEN);
  ingest(db, [running({ session_ids: [], api_url: agentUrl() })], now);
  // 宛先の表を消して、起こしの検索だけを壊す (依頼の表はそのまま)
  db.$client.exec("DROP TABLE agent_endpoints");
  const { request } = await client.requestResume({ key: key() });
  expect(request?.id).toBeTruthy();
});
