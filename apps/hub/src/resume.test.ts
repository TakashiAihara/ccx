/**
 * ResumeService (#261): 人が置いた「開き直して」の依頼を、そのマシンの ccx-agent が取りに来て結果を返す。
 *
 * HTTP で往復させる (server.test.ts と同じ理由: Connect のエラーコードの写像まで通す)。時計は
 * createApp の now で固定する。
 */

import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResumeOutcome, ResumeService } from "@ccx/proto/ccx/v1/resume_pb.ts";

import { openDb, type Db } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { createApp } from "./server.ts";
import { CLAIM_TIMEOUT_MS, DETAIL_CAP, REQUEST_TTL_MS } from "./resume.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = 1_800_000_000_000;

let server: ReturnType<typeof Bun.serve>;
let db: Db;
let objectsDir: string;
let now = T0;
let client: ReturnType<typeof createClient<typeof ResumeService>>;

beforeEach(async () => {
  now = T0;
  db = openDb(":memory:");
  objectsDir = await mkdtemp(join(tmpdir(), "ccx-resume-objects-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(objectsDir), { now: () => now }).fetch });
  client = createClient(ResumeService, createConnectTransport({ baseUrl: `http://127.0.0.1:${server.port}`, httpVersion: "1.1" }));
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await rm(objectsDir, { recursive: true, force: true });
});

const key = (sessionId = A, machine = "m1", user = "dev") => ({ machine, user, sessionId });

async function code(p: Promise<unknown>): Promise<Code | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return ConnectError.from(e).code;
  }
}

test("取り直しの窓は 5 分", () => {
  expect(CLAIM_TIMEOUT_MS).toBe(300_000);
});

test("依頼を置くと、まだ誰も取っていない依頼として返る", async () => {
  const { request } = await client.requestResume({ key: key(), force: true });
  expect(request?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(request?.key).toMatchObject(key());
  expect(request?.force).toBe(true);
  expect(Number(request?.requestedAt?.seconds)).toBe(T0 / 1000);
  expect(request?.claimedAt).toBeUndefined();
  expect(request?.finishedAt).toBeUndefined();
  expect(request?.outcome).toBe(ResumeOutcome.UNSPECIFIED);
});

test("同じ session に終わっていない依頼があれば、新しく作らずそれを返す", async () => {
  const first = await client.requestResume({ key: key() });
  now += 1000;
  const second = await client.requestResume({ key: key() });
  expect(second.request?.id).toBe(first.request!.id);
  expect((await client.listResumeRequests({})).requests).toHaveLength(1);
});

test("大文字で置かれた id は小文字で持ち、小文字の依頼と同じものとして扱う", async () => {
  const first = await client.requestResume({ key: key(A.toUpperCase()) });
  expect(first.request?.key?.sessionId).toBe(A);
  const second = await client.requestResume({ key: key(A) });
  expect(second.request?.id).toBe(first.request!.id);
  expect((await client.listResumeRequests({ sessionId: A.toUpperCase() })).requests).toHaveLength(1);
});

test("終わった依頼の後なら、同じ session でも新しく作る", async () => {
  const first = await client.requestResume({ key: key() });
  const c = await client.claimResume({ machine: "m1", user: "dev" });
  await client.finishResume({ id: first.request!.id, outcome: ResumeOutcome.FAILED, detail: "x", exitCode: 1, claimToken: c.request!.claimToken });
  const second = await client.requestResume({ key: key() });
  expect(second.request?.id).not.toBe(first.request!.id);
});

test("key が欠けている / session id でない依頼は InvalidArgument", async () => {
  expect(await code(client.requestResume({ key: { machine: "", user: "dev", sessionId: A } }))).toBe(Code.InvalidArgument);
  expect(await code(client.requestResume({ key: { machine: "m1", user: "", sessionId: A } }))).toBe(Code.InvalidArgument);
  expect(await code(client.requestResume({ key: key("not-a-uuid") }))).toBe(Code.InvalidArgument);
  expect(await code(client.requestResume({}))).toBe(Code.InvalidArgument);
});

test("Claim は自分宛ての最古の 1 件を取り、claimed_at を付ける", async () => {
  const a = await client.requestResume({ key: key(A) });
  now += 1000;
  await client.requestResume({ key: key(B) });
  await client.requestResume({ key: key(A, "m2") });
  now += 1000;

  const got = await client.claimResume({ machine: "m1", user: "dev" });

  expect(got.request?.id).toBe(a.request!.id);
  expect(Number(got.request?.claimedAt?.seconds)).toBe((T0 + 2000) / 1000);
});

test("取られた依頼は、窓の間は他の Claim に出ない", async () => {
  await client.requestResume({ key: key(A) });
  await client.claimResume({ machine: "m1", user: "dev" });
  now += CLAIM_TIMEOUT_MS - 1;
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request).toBeUndefined();
});

test("結果が返らないまま窓を過ぎた依頼は、もう一度取れる", async () => {
  const a = await client.requestResume({ key: key(A) });
  await client.claimResume({ machine: "m1", user: "dev" });
  now += CLAIM_TIMEOUT_MS;
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request?.id).toBe(a.request!.id);
});

test("別のマシン・別のユーザーの依頼は取らない", async () => {
  await client.requestResume({ key: key(A, "m2") });
  await client.requestResume({ key: key(A, "m1", "alice") });
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request).toBeUndefined();
});

test("Claim の machine / user が空なら InvalidArgument", async () => {
  expect(await code(client.claimResume({ machine: "", user: "dev" }))).toBe(Code.InvalidArgument);
  expect(await code(client.claimResume({ machine: "m1", user: "" }))).toBe(Code.InvalidArgument);
});

test("Finish は結果を記録し、終わった依頼は Claim に出ない", async () => {
  const a = await client.requestResume({ key: key(A) });
  const c = await client.claimResume({ machine: "m1", user: "dev" });
  now += 5000;

  const fin = await client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED, detail: "opened wRK pane=wRK:p1", exitCode: 0, claimToken: c.request!.claimToken });

  expect(fin.request?.outcome).toBe(ResumeOutcome.OPENED);
  expect(fin.request?.detail).toBe("opened wRK pane=wRK:p1");
  expect(fin.request?.exitCode).toBe(0);
  expect(Number(fin.request?.finishedAt?.seconds)).toBe((T0 + 5000) / 1000);
  now += CLAIM_TIMEOUT_MS * 2;
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request).toBeUndefined();
});

test("取っていない依頼の Finish は FailedPrecondition", async () => {
  const a = await client.requestResume({ key: key(A) });
  expect(await code(client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED }))).toBe(Code.FailedPrecondition);
});

test("終わった依頼の 2 度目の Finish は FailedPrecondition で、最初の結果を変えない", async () => {
  const a = await client.requestResume({ key: key(A) });
  const c = await client.claimResume({ machine: "m1", user: "dev" });
  const claimToken = c.request!.claimToken;
  await client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.FAILED, detail: "first", exitCode: 3, claimToken });
  expect(await code(client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED, detail: "second", claimToken }))).toBe(Code.FailedPrecondition);
  const [r] = (await client.listResumeRequests({})).requests;
  expect(r?.detail).toBe("first");
  expect(r?.exitCode).toBe(3);
});

test("知らない id の Finish は NotFound、outcome の無い Finish は InvalidArgument", async () => {
  expect(await code(client.finishResume({ id: "0199aaaa-0000-7000-8000-000000000000", outcome: ResumeOutcome.OPENED }))).toBe(Code.NotFound);
  const a = await client.requestResume({ key: key(A) });
  const c = await client.claimResume({ machine: "m1", user: "dev" });
  expect(await code(client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.UNSPECIFIED, claimToken: c.request!.claimToken }))).toBe(Code.InvalidArgument);
});

test("一覧は requested_at の新しい順で、machine / user / session_id で絞れ、limit が効く", async () => {
  await client.requestResume({ key: key(A) });
  now += 1000;
  await client.requestResume({ key: key(B) });
  now += 1000;
  await client.requestResume({ key: key(A, "m2") });

  const all = (await client.listResumeRequests({})).requests.map((r) => [r.key?.machine, r.key?.sessionId]);
  expect(all).toEqual([
    ["m2", A],
    ["m1", B],
    ["m1", A],
  ]);
  expect((await client.listResumeRequests({ machine: "m1" })).requests).toHaveLength(2);
  expect((await client.listResumeRequests({ sessionId: B })).requests).toHaveLength(1);
  expect((await client.listResumeRequests({ user: "alice" })).requests).toHaveLength(0);
  expect((await client.listResumeRequests({ limit: 1 })).requests.map((r) => r.key?.machine)).toEqual(["m2"]);
});

test("FleetService.ListSessions は liveness を返し、stopped_only で絞る (時計は createApp の now)", async () => {
  const { FleetService, Liveness } = await import("@ccx/proto/ccx/v1/fleet_pb.ts");
  const { IngestService } = await import("@ccx/proto/ccx/v1/ingest_pb.ts");
  const { timestampFromMs } = await import("@bufbuild/protobuf/wkt");
  const transport = createConnectTransport({ baseUrl: `http://127.0.0.1:${server.port}`, httpVersion: "1.1" });
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const ev = (id: string, producer: number, payload: unknown, at: number) => ({
    eventId: id,
    origin: { machine: "m1", user: "dev" },
    seq: 1n,
    receivedAt: timestampFromMs(at),
    producer,
    payload: enc(payload),
  });
  await createClient(IngestService, transport).ingest({
    events: [
      ev("e1", 1, { session_id: A, hook_event_name: "Stop" }, T0 - 60_000),
      ev("e2", 1, { session_id: B, hook_event_name: "Stop" }, T0 - 50_000),
      ev("e3", 3, { session_ids: [B] }, T0 - 10_000),
    ],
  });
  const fleet = createClient(FleetService, transport);

  const all = (await fleet.listSessions({})).sessions.map((s) => [s.key?.sessionId, s.liveness]);
  expect(all).toEqual([
    [B, Liveness.RUNNING],
    [A, Liveness.STOPPED],
  ]);
  expect((await fleet.listSessions({ stoppedOnly: true })).sessions.map((s) => s.key?.sessionId)).toEqual([A]);

  now += 300_001;
  expect((await fleet.listSessions({})).sessions.map((s) => s.liveness)).toEqual([Liveness.UNSPECIFIED, Liveness.UNSPECIFIED]);
});

test("依頼の期限は 10 分、detail の上限は 4096 文字", () => {
  expect(REQUEST_TTL_MS).toBe(600_000);
  expect(DETAIL_CAP).toBe(4096);
});

test("取るたびに新しい claim_token が振られ、取り直された後の古い結果は断る", async () => {
  const a = await client.requestResume({ key: key(A) });
  const first = (await client.claimResume({ machine: "m1", user: "dev" })).request!;
  now += CLAIM_TIMEOUT_MS;
  const second = (await client.claimResume({ machine: "m1", user: "dev" })).request!;
  expect(first.claimToken).not.toBe("");
  expect(second.claimToken).not.toBe(first.claimToken);

  expect(await code(client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED, claimToken: first.claimToken }))).toBe(Code.FailedPrecondition);
  expect(await code(client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED }))).toBe(Code.FailedPrecondition);
  const fin = await client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED, claimToken: second.claimToken });
  expect(fin.request?.outcome).toBe(ResumeOutcome.OPENED);
});

test("期限を過ぎた依頼は取らず、expired と出し、同じ session に新しい依頼を作れる", async () => {
  const a = await client.requestResume({ key: key(A) });
  now += REQUEST_TTL_MS - 1;
  expect((await client.listResumeRequests({})).requests[0]?.expired).toBe(false);
  now += 1;
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request).toBeUndefined();
  expect((await client.listResumeRequests({})).requests[0]?.expired).toBe(true);

  const b = await client.requestResume({ key: key(A) });
  expect(b.request?.id).not.toBe(a.request!.id);
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request?.id).toBe(b.request!.id);
});

test("取ったまま期限を過ぎた依頼も、同じ session の次の依頼を塞がない", async () => {
  const a = await client.requestResume({ key: key(A) });
  await client.claimResume({ machine: "m1", user: "dev" });
  now += REQUEST_TTL_MS;
  const b = await client.requestResume({ key: key(A) });
  expect(b.request?.id).not.toBe(a.request!.id);
});

test("終わった依頼は期限を過ぎても expired にしない", async () => {
  const a = await client.requestResume({ key: key(A) });
  const c = await client.claimResume({ machine: "m1", user: "dev" });
  await client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.OPENED, claimToken: c.request!.claimToken });
  now += REQUEST_TTL_MS * 2;
  expect((await client.listResumeRequests({})).requests[0]?.expired).toBe(false);
});

test("終わっていない依頼に force=true が来たら、その依頼を force にする (false では戻さない)", async () => {
  const a = await client.requestResume({ key: key(A) });
  expect(a.request?.force).toBe(false);
  const b = await client.requestResume({ key: key(A), force: true });
  expect(b.request?.id).toBe(a.request!.id);
  expect(b.request?.force).toBe(true);
  const c = await client.requestResume({ key: key(A), force: false });
  expect(c.request?.force).toBe(true);
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request?.force).toBe(true);
});

test("wait_seconds は依頼に残り、agent が取ったときにも返る", async () => {
  const a = await client.requestResume({ key: key(A), waitSeconds: 90 });
  expect(a.request?.waitSeconds).toBe(90);
  expect((await client.claimResume({ machine: "m1", user: "dev" })).request?.waitSeconds).toBe(90);
});

test("長い detail は末尾の 4096 文字だけを持つ", async () => {
  const a = await client.requestResume({ key: key(A) });
  const c = await client.claimResume({ machine: "m1", user: "dev" });
  const detail = "あ".repeat(5000) + "END";
  const fin = await client.finishResume({ id: a.request!.id, outcome: ResumeOutcome.FAILED, detail, exitCode: 4, claimToken: c.request!.claimToken });
  expect([...fin.request!.detail].length).toBe(4096);
  expect(fin.request!.detail.endsWith("END")).toBe(true);
  expect([...(await client.listResumeRequests({})).requests[0]!.detail].length).toBe(4096);
});

test("Ingest は読めない動いている一覧を INVALID_ARGUMENT で断る", async () => {
  const { IngestService } = await import("@ccx/proto/ccx/v1/ingest_pb.ts");
  const { timestampFromMs } = await import("@bufbuild/protobuf/wkt");
  const transport = createConnectTransport({ baseUrl: `http://127.0.0.1:${server.port}`, httpVersion: "1.1" });
  const ingest = createClient(IngestService, transport);
  const bad = { eventId: "r1", origin: { machine: "m1", user: "dev" }, seq: 0n, receivedAt: timestampFromMs(T0), producer: 3, payload: new TextEncoder().encode("{") };
  expect(await code(ingest.ingest({ events: [bad] }))).toBe(Code.InvalidArgument);
});
