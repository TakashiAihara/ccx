import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";
import { IngestService } from "@ccx/proto/ccx/v1/ingest_pb.ts";

import { presentedToken } from "./auth.ts";
import { openDb, type Db } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { createApp } from "./server.ts";

// 実行ごとに作る。固定の文字列にすると秘密の検知に引っかかるうえ、意味も無い
const TOKEN = randomUUID();

let server: ReturnType<typeof Bun.serve>;
let db: Db;
let dir: string;
let base: string;

async function start(token?: string) {
  db = openDb(":memory:");
  dir = await mkdtemp(join(tmpdir(), "ccx-auth-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(dir), { token }).fetch });
  base = `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

const bearer =
  (t: string): Interceptor =>
  (next) =>
  (req) => {
    req.header.set("Authorization", `Bearer ${t}`);
    return next(req);
  };

function transport(token?: string) {
  return createConnectTransport({ baseUrl: base, httpVersion: "1.1", interceptors: token ? [bearer(token)] : [] });
}

const s3 = (key: string) => new Bun.S3Client({ endpoint: base, bucket: "ccx", accessKeyId: key, secretAccessKey: "unused" });

describe("token が設定された center", () => {
  beforeEach(() => start(TOKEN));

  test("Connect: token 無しと違う token は Unauthenticated、正しい Bearer は通る", async () => {
    for (const t of [undefined, "wrong"]) {
      const err = await createClient(FleetService, transport(t)).listSessions({}).catch((e) => e);
      expect(ConnectError.from(err).code).toBe(Code.Unauthenticated);
    }
    expect((await createClient(FleetService, transport(TOKEN)).listSessions({})).sessions).toEqual([]);
  });

  test("Ingest も同じ口で守られる", async () => {
    const ev = {
      eventId: "01a050b0-4c8c-7e7a-9e2b-000000000001",
      origin: { machine: "m", user: "u" },
      seq: 1n,
      receivedAt: timestampFromMs(1_700_000_000_000),
      producer: 1,
      payload: new TextEncoder().encode("{}"),
    };
    const err = await createClient(IngestService, transport()).ingest({ events: [ev] }).catch((e) => e);
    expect(ConnectError.from(err).code).toBe(Code.Unauthenticated);
    expect((await createClient(IngestService, transport(TOKEN)).ingest({ events: [ev] })).accepted).toBe(1);
  });

  test("object API: access key id が token の S3 クライアントだけが読み書きできる", async () => {
    await s3(TOKEN).write("a/b.txt", "hello");
    expect(await s3(TOKEN).file("a/b.txt").text()).toBe("hello");
    for (const k of ["ccx", "wrong"]) {
      const err = await s3(k).file("a/b.txt").text().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
    }
    expect((await fetch(`${base}/ccx/a/b.txt`)).status).toBe(401);
  });

  test("presigned URL は X-Amz-Credential の access key id で通る", async () => {
    await s3(TOKEN).write("p.txt", "presigned");
    expect(await (await fetch(s3(TOKEN).presign("p.txt"))).text()).toBe("presigned");
    expect((await fetch(s3("wrong").presign("p.txt"))).status).toBe(401);
  });

  test("/healthz は token 無しで答える (生死の確認と `ccx agent status`)", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("token の無い center", () => {
  beforeEach(() => start(undefined));

  test("今までどおり開いている", async () => {
    expect((await createClient(FleetService, transport()).listSessions({})).sessions).toEqual([]);
    expect((await fetch(`${base}/ccx`)).status).not.toBe(401);
  });
});

describe("presentedToken", () => {
  const u = new URL("http://h/b/k");

  test("Bearer / SigV4 の Credential / presigned の X-Amz-Credential を読む", () => {
    expect(presentedToken("Bearer abc", u)).toBe("abc");
    expect(
      presentedToken("AWS4-HMAC-SHA256 Credential=abc/20260924/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=x", u),
    ).toBe("abc");
    const pre = new URL("http://h/b/k?X-Amz-Credential=abc%2F20260924%2Fus-east-1%2Fs3%2Faws4_request");
    expect(presentedToken(undefined, pre)).toBe("abc");
  });

  test("読めない形は undefined (Basic や素の文字列を token として通さない)", () => {
    expect(presentedToken("Basic abc", u)).toBeUndefined();
    expect(presentedToken("abc", u)).toBeUndefined();
    expect(presentedToken(undefined, u)).toBeUndefined();
  });
});
