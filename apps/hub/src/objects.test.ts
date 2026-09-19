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
import { ObjectStore, partNumbersOf, validKey, validPrefix } from "./objects.ts";
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
    // headersOf は全体の size を渡すが、206 では Bun.serve が切った長さに書き換える
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");

    const tail = await fetch(`${base}/ccx/r.txt`, { headers: { range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 7-9/10");
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

    // CommonPrefixes も max-keys に数える。数えないと delimiter 付きの一覧が
    // 上限を超えても truncated にならず、2 ページ目が永遠に来ない
    const d1 = await s3.list({ prefix: "t/", delimiter: "/", maxKeys: 1 });
    expect(d1.commonPrefixes?.map((p) => p.prefix)).toEqual(["t/m=a/"]);
    expect(d1.isTruncated).toBe(true);
    const d2 = await s3.list({ prefix: "t/", delimiter: "/", maxKeys: 1, continuationToken: d1.nextContinuationToken });
    expect(d2.commonPrefixes?.map((p) => p.prefix)).toEqual(["t/m=b/"]);
    expect(d2.isTruncated).toBe(false);

    // 未知の bucket は空の一覧 (bucket は暗黙に存在する)
    const other = new Bun.S3Client({ endpoint: base, bucket: "nothing-here", accessKeyId: "t", secretAccessKey: "t" });
    expect((await other.list()).contents ?? []).toEqual([]);
  });

  test("missing key is NoSuchKey, a key that escapes the root is rejected", async () => {
    await expect(s3.file("nope").text()).rejects.toThrow();
    const res = await fetch(`${base}/ccx/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("NoSuchKey");

    // fetch は `..` を送る前に畳むので、server に届く形で書く。2 段上がると root の
    // 外なので、そこに無いことを見る
    const bad = await fetch(`${base}/ccx/%2e%2e/%2e%2e/escaped`, { method: "PUT", body: "x" });
    expect(bad.status).toBe(400);
    expect(await Bun.file(join(root, "..", "escaped")).exists()).toBe(false);

    const malformed = await fetch(`${base}/ccx/%99`);
    expect(malformed.status).toBe(400);

    const barePost = await fetch(`${base}/ccx/k`, { method: "POST", body: "x" });
    expect(barePost.status).toBe(405);

    const badBucket = await fetch(`${base}/Not_Valid/k`, { method: "PUT", body: "x" });
    expect(badBucket.status).toBe(400);
  });

  test("uploadId and prefix cannot point outside the root", async () => {
    // abort に `../../<dir>` を渡しても root の外は消えない
    const outside = join(root, "..", `ccx-outside-${Date.now()}`);
    await Bun.write(join(outside, "keep"), "x");
    try {
      const abort = await fetch(`${base}/ccx/k?uploadId=${encodeURIComponent(`../../${outside.split("/").pop()}`)}`, {
        method: "DELETE",
      });
      expect(abort.status).toBe(404);
      expect(await Bun.file(join(outside, "keep")).exists()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    // 一覧の prefix で bucket の外を歩かせない
    const res = await fetch(`${base}/ccx?list-type=2&prefix=${encodeURIComponent("../")}`);
    expect(res.status).toBe(400);
    const part = await fetch(`${base}/ccx/k?partNumber=1&uploadId=not-a-uuid`, { method: "PUT", body: "x" });
    expect(part.status).toBe(404);
  });

  test("complete uses the parts the client lists, in that order, and refuses a missing one", async () => {
    const init = await fetch(`${base}/ccx/m.txt?uploads`, { method: "POST" });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await init.text())![1]!;
    for (const [n, body] of [
      [1, "AAA"],
      [2, "BBB"],
      [3, "CCC"],
    ] as const) {
      expect((await fetch(`${base}/ccx/m.txt?partNumber=${n}&uploadId=${uploadId}`, { method: "PUT", body })).status).toBe(200);
    }
    const listing = (parts: number[]) =>
      `<CompleteMultipartUpload>${parts.map((n) => `<Part><PartNumber>${n}</PartNumber><ETag>"x"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;

    // 存在しない part を挙げると断られ、upload は残る
    const bad = await fetch(`${base}/ccx/m.txt?uploadId=${uploadId}`, { method: "POST", body: listing([1, 9]) });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("InvalidPart");

    // 挙げた part だけを、挙げた順に
    const ok = await fetch(`${base}/ccx/m.txt?uploadId=${uploadId}`, { method: "POST", body: listing([3, 1]) });
    expect(ok.status).toBe(200);
    expect(await s3.file("m.txt").text()).toBe("CCCAAA");
  });

  test("a filesystem failure other than ENOENT is an error, not a 404", async () => {
    // key の途中にファイルがあると、その下の stat は ENOTDIR で落ちる
    await s3.write("file", "x");
    const res = await fetch(`${base}/ccx/file/child`);
    expect(res.status).toBe(500);
  });

  test("routes registered before the bucket route still win", async () => {
    // `healthz` は bucket 名として有効なので、順序が逆だと空の一覧 (XML) が返る
    const hz = await fetch(`${base}/healthz`);
    expect(await hz.text()).toBe("ok\n");

    const res = await fetch(`${base}/ccx.v1.FleetService/ListSessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    // proto3 の JSON は空の repeated を省く
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({});
  });

  test("a key ending in .tmp is listed like any other", async () => {
    await s3.write("exports/dump.tmp", "x");
    expect((await s3.list({ prefix: "exports/" })).contents?.map((o) => o.key)).toEqual(["exports/dump.tmp"]);
  });
});

describe("objects: helpers", () => {
  test("validPrefix", () => {
    expect(validPrefix("")).toBe(true);
    expect(validPrefix("t/")).toBe(true);
    expect(validPrefix("t/m=a/sess")).toBe(true);
    expect(validPrefix("../")).toBe(false);
    expect(validPrefix("a/../b")).toBe(false);
    expect(validPrefix("a//b")).toBe(false);
  });

  test("partNumbersOf", () => {
    expect(partNumbersOf("<CompleteMultipartUpload><Part><PartNumber>2</PartNumber></Part><Part><PartNumber> 1 </PartNumber></Part></CompleteMultipartUpload>")).toEqual([2, 1]);
    expect(partNumbersOf("")).toEqual([]);
  });

  test("validKey", () => {
    expect(validKey("a/b.c")).toBe(true);
    expect(validKey("")).toBe(false);
    expect(validKey("a//b")).toBe(false);
    expect(validKey("../x")).toBe(false);
    expect(validKey("a/./b")).toBe(false);
  });


});
