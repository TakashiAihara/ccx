/**
 * MessageRelayService (#138): 送り手の ccx-agent が置いたメッセージを、宛先の ccx-agent が 1 度だけ取り、ack を書く。
 * HTTP で往復させて Connect のエラーコードまで通す (resume.test.ts と同じ形)。
 */

import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeliveryMode, MessageRelayService, SendResponse_State } from "@ccx/proto/ccx/v1/message_pb.ts";

import { openDb, type Db } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { createApp } from "./server.ts";

const T0 = 1_800_000_000_000;

let server: ReturnType<typeof Bun.serve>;
let db: Db;
let objectsDir: string;
let now = T0;
let client: ReturnType<typeof createClient<typeof MessageRelayService>>;

beforeEach(async () => {
  now = T0;
  db = openDb(":memory:");
  objectsDir = await mkdtemp(join(tmpdir(), "ccx-relay-objects-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(objectsDir), { now: () => now }).fetch });
  client = createClient(MessageRelayService, createConnectTransport({ baseUrl: `http://127.0.0.1:${server.port}`, httpVersion: "1.1" }));
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await rm(objectsDir, { recursive: true, force: true });
});

const req = (body = "hello", machine = "m2", user = "dev") => ({
  target: "devin-x",
  mode: DeliveryMode.URGENT,
  summary: "s",
  sender: "me",
  body,
  machine,
  user,
});

async function code(p: Promise<unknown>): Promise<Code | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return ConnectError.from(e).code;
  }
}

test("宛先の machine と user が無い置き方は断る", async () => {
  expect(await code(client.putMessage({ request: req("b", "", "dev") }))).toBe(Code.InvalidArgument);
  expect(await code(client.putMessage({ request: req("b", "m2", "") }))).toBe(Code.InvalidArgument);
  expect(await code(client.putMessage({}))).toBe(Code.InvalidArgument);
});

test("本文の上限を大きく超える置き方は断る", async () => {
  expect(await code(client.putMessage({ request: req("x".repeat(71 * 1024)) }))).toBe(Code.InvalidArgument);
  expect(await code(client.putMessage({ request: req("x".repeat(64 * 1024)) }))).toBe("ok");
});

test("置いた本文を宛先の agent が取り、claim_token は取った agent にだけ渡る", async () => {
  const put = (await client.putMessage({ request: req("first") })).message!;
  expect(put.claimToken).toBe("");
  expect(put.claimedAt).toBeUndefined();

  // 他の宛先には渡さない
  expect((await client.claimMessage({ machine: "m3", user: "dev" })).message).toBeUndefined();
  expect((await client.claimMessage({ machine: "m2", user: "other" })).message).toBeUndefined();

  const got = (await client.claimMessage({ machine: "m2", user: "dev" })).message!;
  expect(got.id).toBe(put.id);
  expect(got.request?.body).toBe("first");
  expect(got.request?.target).toBe("devin-x");
  expect(got.claimToken).not.toBe("");

  const read = (await client.getMessage({ id: put.id })).message!;
  expect(read.claimToken).toBe("");
  expect(read.claimedAt).toBeDefined();
});

test("古い順に取り、取った行は時間が経っても二度と渡さない", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  now += 1000;
  const b = (await client.putMessage({ request: req("b") })).message!;

  expect((await client.claimMessage({ machine: "m2", user: "dev" })).message?.id).toBe(a.id);
  expect((await client.claimMessage({ machine: "m2", user: "dev" })).message?.id).toBe(b.id);
  now += 10 * 60 * 1000;
  expect((await client.claimMessage({ machine: "m2", user: "dev" })).message).toBeUndefined();
});

test("30 秒取られなかった行は expired になり、渡さない", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  now += 29_999;
  expect((await client.getMessage({ id: a.id })).message?.expired).toBe(false);
  now += 1;
  expect((await client.getMessage({ id: a.id })).message?.expired).toBe(true);
  expect((await client.claimMessage({ machine: "m2", user: "dev" })).message).toBeUndefined();
});

test("取られた行は 30 秒を過ぎても expired にしない", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  await client.claimMessage({ machine: "m2", user: "dev" });
  now += 60_000;
  expect((await client.getMessage({ id: a.id })).message?.expired).toBe(false);
});

test("ack は報告のたびに置き換わり、終わった後の報告と token 違いは断る", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  // 取られる前の報告は断る
  expect(await code(client.reportMessage({ id: a.id, claimToken: "", acks: [] }))).toBe(Code.FailedPrecondition);
  const token = (await client.claimMessage({ machine: "m2", user: "dev" })).message!.claimToken;

  expect(await code(client.reportMessage({ id: a.id, claimToken: "wrong", acks: [{ state: SendResponse_State.SENT }] }))).toBe(Code.FailedPrecondition);

  await client.reportMessage({ id: a.id, claimToken: token, acks: [{ state: SendResponse_State.SENT, detail: "pane w1:p1" }] });
  let m = (await client.getMessage({ id: a.id })).message!;
  expect(m.acks.map((x) => [x.state, x.detail])).toEqual([[SendResponse_State.SENT, "pane w1:p1"]]);
  expect(m.finishedAt).toBeUndefined();

  // 同じ報告の送り直しで ack が増えない
  await client.reportMessage({ id: a.id, claimToken: token, acks: [{ state: SendResponse_State.SENT, detail: "pane w1:p1" }] });
  expect((await client.getMessage({ id: a.id })).message!.acks.length).toBe(1);

  await client.reportMessage({
    id: a.id,
    claimToken: token,
    acks: [{ state: SendResponse_State.SENT, detail: "pane w1:p1" }],
    finished: true,
    errorCode: Code.FailedPrecondition,
    errorMessage: "box has text",
    notTyped: true,
  });
  m = (await client.getMessage({ id: a.id })).message!;
  expect(m.finishedAt).toBeDefined();
  expect([m.errorCode, m.errorMessage, m.notTyped]).toEqual([Code.FailedPrecondition, "box has text", true]);

  expect(await code(client.reportMessage({ id: a.id, claimToken: token, acks: [], finished: true }))).toBe(Code.FailedPrecondition);
});

test("finished の無い報告は終わりにしない", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  const token = (await client.claimMessage({ machine: "m2", user: "dev" })).message!.claimToken;
  await client.reportMessage({ id: a.id, claimToken: token, acks: [], errorCode: Code.Internal, notTyped: true });
  const m = (await client.getMessage({ id: a.id })).message!;
  expect([m.finishedAt, m.errorCode, m.notTyped]).toEqual([undefined, 0, false]);
});

test("取りに来た agent の machine と user が無ければ断る", async () => {
  expect(await code(client.claimMessage({ machine: "", user: "dev" }))).toBe(Code.InvalidArgument);
  expect(await code(client.claimMessage({ machine: "m2", user: "" }))).toBe(Code.InvalidArgument);
});

test("知らない id は NOT_FOUND", async () => {
  expect(await code(client.getMessage({ id: "nope" }))).toBe(Code.NotFound);
  expect(await code(client.reportMessage({ id: "nope", claimToken: "x" }))).toBe(Code.NotFound);
});

test("1 時間より古い行は次の置き方で消える", async () => {
  const old = (await client.putMessage({ request: req("old") })).message!;
  now += 60 * 60 * 1000;
  await client.putMessage({ request: req("new") });
  expect((await client.getMessage({ id: old.id })).message?.request?.body).toBe("old");
  now += 1;
  await client.putMessage({ request: req("newer") });
  expect(await code(client.getMessage({ id: old.id }))).toBe(Code.NotFound);
});
