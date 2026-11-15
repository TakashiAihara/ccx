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
  await claimed("m2", "dev");
});

// The receiving ccx-agent asking for its messages: what tells the center that machine / user takes them.
async function claimed(machine: string, user: string): Promise<void> {
  await client.claimMessage({ machine, user });
}

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

test("取りに来たことの無い宛先は待たずに断り、大文字小文字だけ違う宛先を先頭に挙げる", async () => {
  await claimed("WIN-TAKASHI", "other");
  await claimed("WIN-TAKASHI", "root");
  await claimed("a-host", "root");
  const e = await client.putMessage({ request: req("b", "win-takashi", "root") }).catch((x: unknown) => ConnectError.from(x));
  expect(e).toBeInstanceOf(ConnectError);
  expect((e as ConnectError).code).toBe(Code.InvalidArgument);
  // Only the one that differs in case alone comes first: the same machine as another user is not it.
  expect((e as ConnectError).rawMessage).toBe("no ccx-agent has asked this center for messages as win-takashi/root; these have: WIN-TAKASHI/root, a-host/root, m2/dev, WIN-TAKASHI/other");

  expect(await code(client.putMessage({ request: req("b", "m2", "root") }))).toBe(Code.InvalidArgument);
  expect(await code(client.putMessage({ request: req("b", "WIN-TAKASHI", "root") }))).toBe("ok");
  expect(db.$client.query("select count(*) as n from relay_messages").get()).toEqual({ n: 1 });
});

test("どの agent も取りに来ていなければ、そう言って断る", async () => {
  db.$client.run("delete from relay_receivers");
  const e = await client.putMessage({ request: req("b") }).catch((x: unknown) => ConnectError.from(x));
  expect((e as ConnectError).rawMessage).toBe("no ccx-agent has asked this center for messages as m2/dev; none has yet");
});

test("宛先の名前がどれだけ長くても、断る理由の文は detail と同じ長さまで", async () => {
  const e = await client.putMessage({ request: req("b", "x".repeat(8000), "u") }).catch((x: unknown) => ConnectError.from(x));
  expect((e as ConnectError).code).toBe(Code.InvalidArgument);
  expect(Buffer.byteLength((e as ConnectError).rawMessage)).toBeLessThanOrEqual(4096);
  expect((e as ConnectError).rawMessage).toEndWith("these have: m2/dev");
});

test("取りに来た宛先は 10 件まで挙げる", async () => {
  db.$client.run("delete from relay_receivers");
  for (let i = 0; i < 11; i++) await claimed(`h${String(i).padStart(2, "0")}`, "u");
  const e = await client.putMessage({ request: req("b", "zz", "u") }).catch((x: unknown) => ConnectError.from(x));
  expect((e as ConnectError).rawMessage).toBe("no ccx-agent has asked this center for messages as zz/u; these have: h00/u, h01/u, h02/u, h03/u, h04/u, h05/u, h06/u, h07/u, h08/u, h09/u, …");
});

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

test("報告の ack の数・エラーコードは上限を超えれば断り、文は 4096 バイトに切る", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  const token = (await client.claimMessage({ machine: "m2", user: "dev" })).message!.claimToken;
  const acks = (n: number) => Array.from({ length: n }, () => ({ state: SendResponse_State.SENT }));
  expect(await code(client.reportMessage({ id: a.id, claimToken: token, acks: acks(17) }))).toBe(Code.InvalidArgument);
  expect(await code(client.reportMessage({ id: a.id, claimToken: token, acks: acks(16) }))).toBe("ok");
  expect(await code(client.reportMessage({ id: a.id, claimToken: token, acks: [], errorCode: 17 }))).toBe(Code.InvalidArgument);
  expect(await code(client.reportMessage({ id: a.id, claimToken: token, acks: [], errorCode: -1 }))).toBe(Code.InvalidArgument);

  await client.reportMessage({ id: a.id, claimToken: token, acks: [{ state: SendResponse_State.SENT, detail: "d".repeat(5000) }, ...acks(15)], finished: true, errorCode: 16, errorMessage: "e".repeat(5000) });
  const m = (await client.getMessage({ id: a.id })).message!;
  expect([m.errorCode, m.errorMessage.length, m.acks[0]!.detail.length]).toEqual([16, 4096, 4096]);
});

test("question の問い・選択肢と done の文を残し、数は 8 問 / 16 個、文は 4096 バイトに切る", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  const token = (await client.claimMessage({ machine: "m2", user: "dev" })).message!.claimToken;
  const options = Array.from({ length: 17 }, (_, i) => ({ label: `o${i}`, description: `d${i}` }));
  const questions = Array.from({ length: 9 }, (_, i) => ({ question: `q${i}`, header: `h${i}`, options }));
  await client.reportMessage({
    id: a.id,
    claimToken: token,
    acks: [
      { state: SendResponse_State.QUESTION, questions },
      { state: SendResponse_State.DONE, text: "t".repeat(5000) },
    ],
  });
  const [q, d] = (await client.getMessage({ id: a.id })).message!.acks;
  expect(q!.questions.map((x) => x.question)).toEqual(["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
  expect([q!.questions[3]!.header, q!.questions[3]!.options.length, q!.questions[3]!.options[15]!.label, q!.questions[3]!.options[15]!.description]).toEqual(["h3", 16, "o15", "d15"]);
  expect([d!.state, d!.text.length]).toEqual([SendResponse_State.DONE, 4096]);
});

test("文を切っても UTF-8 の文字の途中では切らず、末尾を残す", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  const token = (await client.claimMessage({ machine: "m2", user: "dev" })).message!.claimToken;
  // 「あ」は 3 バイト。4096 は 3 で割り切れないので、素直に切ると文字の途中になる
  await client.reportMessage({ id: a.id, claimToken: token, acks: [{ state: SendResponse_State.DONE, text: "x" + "あ".repeat(2000) + "end" }] });
  const d = (await client.getMessage({ id: a.id })).message!.acks[0]!;
  expect(d.text.endsWith("end")).toBe(true);
  expect(new TextEncoder().encode(d.text).length).toBe(4095);
  expect(d.text.startsWith("あ")).toBe(true);
});

test("後から届いた短い ack の一覧で、保存済みの ack を戻さない", async () => {
  const a = (await client.putMessage({ request: req("a") })).message!;
  const token = (await client.claimMessage({ machine: "m2", user: "dev" })).message!.claimToken;
  const sent = { state: SendResponse_State.SENT, detail: "pane" };
  const working = { state: SendResponse_State.WORKING, detail: "" };
  await client.reportMessage({ id: a.id, claimToken: token, acks: [sent, working] });
  await client.reportMessage({ id: a.id, claimToken: token, acks: [sent] });
  expect((await client.getMessage({ id: a.id })).message!.acks.map((x) => x.state)).toEqual([SendResponse_State.SENT, SendResponse_State.WORKING]);

  // 終わりの報告は、一覧が短くても終わりとして書く
  await client.reportMessage({ id: a.id, claimToken: token, acks: [sent], finished: true });
  const m = (await client.getMessage({ id: a.id })).message!;
  expect([m.finishedAt !== undefined, m.acks.length]).toEqual([true, 2]);
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

test("2 時間より古い行は次の置き方で消える", async () => {
  const old = (await client.putMessage({ request: req("old") })).message!;
  now += 2 * 60 * 60 * 1000;
  await client.putMessage({ request: req("new") });
  expect((await client.getMessage({ id: old.id })).message?.request?.body).toBe("old");
  now += 1;
  await client.putMessage({ request: req("newer") });
  expect(await code(client.getMessage({ id: old.id }))).toBe(Code.NotFound);
});

test("期限はロックを取ってから見る: ロック待ちの間に 30 秒を過ぎた行は取らない", async () => {
  // 別プロセスが書き込みロックを握り、claim はそれを待つ (busy_timeout)。待つ前の時刻で期限を見ると、
  // 送り手が expired と読んだ行を取ってしまう
  const dir = await mkdtemp(join(tmpdir(), "ccx-relay-lock-"));
  const file = join(dir, "center.db");
  const fileDb = openDb(file);
  fileDb.$client.run("insert into relay_receivers (machine, os_user, claimed_at_ms) values ('m2', 'dev', 0)");
  const start = Date.now();
  // put の時刻を T0 とし、claim を出す時点で 29.7 秒経っている時計
  let offset = 0;
  const clock = () => T0 + offset + (Date.now() - start);
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(fileDb, new ObjectStore(objectsDir), { now: clock }).fetch });
  const c = createClient(MessageRelayService, createConnectTransport({ baseUrl: `http://127.0.0.1:${srv.port}`, httpVersion: "1.1" }));
  try {
    offset = -(Date.now() - start);
    await c.putMessage({ request: req("late") });

    const holder = Bun.spawn(
      ["bun", "-e", `const { Database } = require("bun:sqlite"); const d = new Database(${JSON.stringify(file)}); d.exec("BEGIN IMMEDIATE"); console.log("locked"); await Bun.sleep(1000); d.exec("COMMIT");`],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    // Set only now that the lock is held, so a clock read on entering the claim sees 29.7 s
    // however long the holder took to start; the lock then holds the claim for about a second
    offset = 29_700 - (Date.now() - start);

    const got = await c.claimMessage({ machine: "m2", user: "dev" });
    expect(got.message).toBeUndefined();
    await holder.exited;
  } finally {
    void srv.stop(true);
    fileDb.$client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
