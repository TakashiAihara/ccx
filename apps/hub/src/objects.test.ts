/**
 * S3 互換 API を、既製の S3 クライアント (Bun.S3Client) で実際に HTTP 越しに叩く。
 * handler を直接呼ぶ形にすると「S3 クライアントが期待する応答の形」(XML の要素名・
 * ETag ヘッダ・206 の Content-Range) を一度も通らずに緑になる。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "./db/open.ts";
import { ObjectStore, validKey } from "./objects.ts";
import { createApp } from "./server.ts";

let server: ReturnType<typeof Bun.serve>;
let db: Db;
let root: string;
let s3: Bun.S3Client;
let base: string;
/** server が受けた request 行。どの経路 (multipart か単発 PUT か) を通ったかを見る */
let requests: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-objects-"));
  db = openDb(":memory:");
  requests = [];
  const app = createApp(db, new ObjectStore(root));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push(`${req.method} ${u.pathname}${u.search}`);
      return app.fetch(req);
    },
    // multipart のテストで 12 MB を送る
    maxRequestBodySize: 64 * 1024 * 1024,
  });
  base = `http://127.0.0.1:${server.port}`;
  s3 = new Bun.S3Client({
    endpoint: base,
    bucket: "ccx",
    accessKeyId: "test",
    secretAccessKey: "test",
    region: "us-east-1",
  });
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await rm(root, { recursive: true, force: true });
});

describe("objects: S3 client round trip", () => {
  test("put / stat / get / delete, and the file is where `ls` would find it", async () => {
    await s3.write("transcripts/machine=a/session_id=s1/transcript.jsonl", "line1\nline2\n");

    const st = await s3.stat("transcripts/machine=a/session_id=s1/transcript.jsonl");
    expect(st.size).toBe(12);
    expect(await s3.file("transcripts/machine=a/session_id=s1/transcript.jsonl").text()).toBe("line1\nline2\n");
    expect(await Bun.file(join(root, "ccx/transcripts/machine=a/session_id=s1/transcript.jsonl")).text()).toBe(
      "line1\nline2\n",
    );

    await s3.delete("transcripts/machine=a/session_id=s1/transcript.jsonl");
    expect(await s3.exists("transcripts/machine=a/session_id=s1/transcript.jsonl")).toBe(false);
    // S3 と同じく、無い key の DELETE は成功
    await s3.delete("transcripts/machine=a/session_id=s1/transcript.jsonl");
  });

  test("a file larger than the part size goes through multipart and comes back intact", async () => {
    // Bun.S3Client は Uint8Array を 1 回の PUT で送る。multipart を通るのはファイル
    // (push が送るのもファイル)。通ったことは `?uploads` の往復で確かめる
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    const src = join(root, "big.src");
    await Bun.write(src, big);
    await s3.write("big.bin", Bun.file(src), { partSize: 5 * 1024 * 1024 });
    expect(requests.filter((r) => r.includes("?uploads")).length).toBe(1);
    expect(requests.filter((r) => r.includes("partNumber=")).length).toBe(3);

    const back = new Uint8Array(await s3.file("big.bin").arrayBuffer());
    expect(back.length).toBe(big.length);
    expect(Buffer.compare(back, big)).toBe(0);
    // 途中の part はディスクに残らない
    const leftovers = await Array.fromAsync(new Bun.Glob("**").scan({ cwd: join(root, ".multipart"), onlyFiles: true })).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  test("Range reads return 206 with the requested slice (what DuckDB httpfs does; Bun.serve slices the stream)", async () => {
    await s3.write("r.txt", "0123456789");
    const res = await fetch(`${base}/ccx/r.txt`, { headers: { range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");

    const tail = await fetch(`${base}/ccx/r.txt`, { headers: { range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");

    const head = await fetch(`${base}/ccx/r.txt`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("accept-ranges")).toBe("bytes");
  });

  test("list: prefix, delimiter (common prefixes) and pagination by continuation token", async () => {
    for (const k of ["t/m=a/s1/transcript.jsonl", "t/m=a/s1/session.json", "t/m=b/s2/transcript.jsonl", "other/x"]) {
      await s3.write(k, k);
    }

    const all = await s3.list({ prefix: "t/" });
    expect(all.contents?.map((o) => o.key)).toEqual([
      "t/m=a/s1/session.json",
      "t/m=a/s1/transcript.jsonl",
      "t/m=b/s2/transcript.jsonl",
    ]);

    const top = await s3.list({ prefix: "t/", delimiter: "/" });
    expect(top.contents ?? []).toEqual([]);
    expect(top.commonPrefixes?.map((p) => p.prefix)).toEqual(["t/m=a/", "t/m=b/"]);

    const p1 = await s3.list({ prefix: "t/", maxKeys: 2 });
    expect(p1.contents?.length).toBe(2);
    expect(p1.isTruncated).toBe(true);
    const p2 = await s3.list({ prefix: "t/", maxKeys: 2, continuationToken: p1.nextContinuationToken });
    expect(p2.contents?.map((o) => o.key)).toEqual(["t/m=b/s2/transcript.jsonl"]);
    expect(p2.isTruncated).toBe(false);

    // 未知の bucket は空の一覧 (bucket は暗黙に存在する)
    const other = new Bun.S3Client({ endpoint: base, bucket: "nothing-here", accessKeyId: "t", secretAccessKey: "t" });
    expect((await other.list()).contents ?? []).toEqual([]);
  });

  test("missing key is NoSuchKey, a key that escapes the root is rejected", async () => {
    await expect(s3.file("nope").text()).rejects.toThrow();
    const res = await fetch(`${base}/ccx/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("NoSuchKey");

    // fetch は `..` を送る前に畳むので、server に届く形で書く
    const bad = await fetch(`${base}/ccx/a/%2e%2e/%2e%2e/escaped`, { method: "PUT", body: "x" });
    expect(bad.status).toBe(400);
    expect(await Bun.file(join(root, "escaped")).exists()).toBe(false);

    const badBucket = await fetch(`${base}/Not_Valid/k`, { method: "PUT", body: "x" });
    expect(badBucket.status).toBe(400);
  });

  test("Connect routes still win over the bucket route", async () => {
    const res = await fetch(`${base}/ccx.v1.FleetService/ListSessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    // proto3 の JSON は空の repeated を省く。bucket として扱われていれば XML が返る
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({});
  });
});

describe("objects: helpers", () => {
  test("validKey", () => {
    expect(validKey("a/b.c")).toBe(true);
    expect(validKey("")).toBe(false);
    expect(validKey("a//b")).toBe(false);
    expect(validKey("../x")).toBe(false);
    expect(validKey("a/./b")).toBe(false);
  });


});
