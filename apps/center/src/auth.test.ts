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

/** S3 クライアントの署名と同じ形の Authorization。署名部分は center が見ないので何でもよい */
const sigv4 = (key: string) => `AWS4-HMAC-SHA256 Credential=${key}/20260924/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=00`;

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

  test("object API: access key id が token の S3 クライアントは読み書きでき、他は 401", async () => {
    await s3(TOKEN).write("a/b.txt", "hello");
    expect(await s3(TOKEN).file("a/b.txt").text()).toBe("hello");
    for (const k of ["ccx", "wrong"]) {
      const r = await fetch(`${base}/ccx/a/b.txt`, { headers: { authorization: sigv4(k) } });
      expect(r.status).toBe(401);
      // S3 クライアントが Message を出せるよう XML で返す
      expect(await r.text()).toContain("<Code>AccessDenied</Code>");
    }
    expect((await fetch(`${base}/ccx/a/b.txt`)).status).toBe(401);
  });

  test("presigned URL は受けない (署名も期限も見ないので、渡すと token を無期限で渡すことになる)", async () => {
    await s3(TOKEN).write("p.txt", "presigned");
    expect((await fetch(s3(TOKEN).presign("p.txt"))).status).toBe(401);
  });

  test("GET / HEAD /healthz だけが token 無しで通る。PUT /healthz は bucket 作成なので守る", async () => {
    // 本文まで見る。object API の route が先に当たると bucket 一覧が 200 で返り、status だけでは区別できない
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok\n");
    expect((await fetch(`${base}/healthz`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${base}/healthz`, { method: "PUT" })).status).toBe(401);
    expect((await fetch(`${base}/healthzx`)).status).toBe(401);
  });
});

describe("token の無い center", () => {
  beforeEach(() => start(undefined));

  test("今までどおり開いている", async () => {
    expect((await createClient(FleetService, transport()).listSessions({})).sessions).toEqual([]);
    await s3("anything").write("x.txt", "open");
    expect(await (await fetch(`${base}/ccx/x.txt`)).text()).toBe("open");
  });
});

describe("presentedToken", () => {
  test("Bearer と SigV4 の Credential を読む", () => {
    expect(presentedToken("Bearer abc")).toBe("abc");
    expect(presentedToken(sigv4("abc"))).toBe("abc");
  });

  test("読めない形は undefined (Basic や素の文字列を token として通さない)", () => {
    expect(presentedToken("Basic abc")).toBeUndefined();
    expect(presentedToken("abc")).toBeUndefined();
    expect(presentedToken(undefined)).toBeUndefined();
  });
});
