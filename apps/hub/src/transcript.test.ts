import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { AppendResponseSchema, TranscriptService } from "@ccx/proto/ccx/v1/transcript_pb.ts";
import { createApp } from "./server.ts";

// HTTP で往復させる (server.test.ts と同じ理由: Connect のエラーコードの写像まで通す)
let server: ReturnType<typeof Bun.serve>;
let db: Db;
let root: string;
let client: ReturnType<typeof createClient<typeof TranscriptService>>;

const SID = "0d5ad3c1-5b6e-4c1f-9a3e-1f2b3c4d5e6f";
const KEY = `transcripts/machine=m1/user=dev/session_id=${SID}/transcript.jsonl`;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-transcript-"));
  db = openDb(":memory:");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(root)).fetch });
  client = createClient(
    TranscriptService,
    createConnectTransport({ baseUrl: `http://127.0.0.1:${server.port}`, httpVersion: "1.1" }),
  );
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await rm(root, { recursive: true, force: true });
});

function req(offset: number, data: string, over: Record<string, unknown> = {}) {
  return {
    origin: { machine: "m1", user: "dev" },
    sessionId: SID,
    offset: BigInt(offset),
    data: enc(data),
    bucket: "ccx",
    prefix: "",
    ...over,
  };
}

/** 断られた Append の code と、detail に入っている center の size */
async function refused(p: Promise<unknown>): Promise<{ code: Code; size: bigint | undefined }> {
  try {
    await p;
  } catch (e) {
    const err = ConnectError.from(e);
    return { code: err.code, size: err.findDetails(AppendResponseSchema)[0]?.size };
  }
  throw new Error("Append succeeded but was expected to be refused");
}

const stored = (key = KEY, bucket = "ccx") => readFile(join(root, bucket, key), "utf8");
const exists = (key = KEY, bucket = "ccx") =>
  stat(join(root, bucket, key)).then(
    () => true,
    () => false,
  );

describe("Append", () => {
  test("offset 0 で新しい object を作り、足した後の size を返す", async () => {
    const res = await client.append(req(0, '{"a":1}\n'));
    expect(res.size).toBe(8n);
    expect(await stored()).toBe('{"a":1}\n');
  });

  test("size と同じ offset なら末尾に足す", async () => {
    await client.append(req(0, '{"a":1}\n'));
    const res = await client.append(req(8, '{"b":2}\n{"c":3}\n'));
    expect(res.size).toBe(24n);
    expect(await stored()).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
  });

  test("prefix は保存先の key の先頭に付く", async () => {
    await client.append(req(0, "x\n", { prefix: "lead/" }));
    expect(await stored(`lead/${KEY}`)).toBe("x\n");
  });

  test("送り済みの bytes の再送 (offset が size より小さい) は書かずに今の size を返して断る", async () => {
    await client.append(req(0, "one\n"));
    await client.append(req(4, "two\n"));
    const r = await refused(client.append(req(4, "two\n")));
    expect(r).toEqual({ code: Code.FailedPrecondition, size: 8n });
    expect(await stored()).toBe("one\ntwo\n");
  });

  test("欠けを作る offset (size より大きい) は書かずに今の size を返して断る", async () => {
    await client.append(req(0, "one\n"));
    const r = await refused(client.append(req(10, "far\n")));
    expect(r).toEqual({ code: Code.FailedPrecondition, size: 4n });
    expect(await stored()).toBe("one\n");
  });

  test("object が無いときの offset > 0 は size 0 を返して断り、object を作らない", async () => {
    const r = await refused(client.append(req(5, "x\n")));
    expect(r).toEqual({ code: Code.FailedPrecondition, size: 0n });
    expect(await exists()).toBe(false);
  });

  test("再起動した送り手は offset 0 で送り、断られた size から続けられる", async () => {
    await client.append(req(0, "one\n"));
    const r = await refused(client.append(req(0, "one\ntwo\n")));
    expect(r.size).toBe(4n);
    const res = await client.append(req(Number(r.size), "two\n"));
    expect(res.size).toBe(8n);
    expect(await stored()).toBe("one\ntwo\n");
  });

  test("空の data は size が一致すれば何も足さずに size を返す", async () => {
    await client.append(req(0, "one\n"));
    expect((await client.append(req(4, ""))).size).toBe(4n);
    expect(await stored()).toBe("one\n");
  });

  test("改行で終わらない data は書かずに INVALID_ARGUMENT", async () => {
    const r = await refused(client.append(req(0, '{"a":1}\n{"b":')));
    expect(r.code).toBe(Code.InvalidArgument);
    expect(await exists()).toBe(false);
  });

  test("同じ offset への同時の Append は 1 本だけが通る", async () => {
    await client.append(req(0, "base\n"));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => client.append(req(5, `line-${i}\n`))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lines = (await stored()).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("base");
  });

  describe("key になる値を検査する", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["session id の形でない", { sessionId: "../../etc" }],
      ["session id が空", { sessionId: "" }],
      ["origin が無い", { origin: undefined }],
      ["machine が空", { origin: { machine: "", user: "dev" } }],
      ["machine に /", { origin: { machine: "a/b", user: "dev" } }],
      ["user に ..", { origin: { machine: "m1", user: ".." } }],
      ["bucket が空", { bucket: "" }],
      ["bucket に /", { bucket: "a/b" }],
      ["prefix に ..", { prefix: "../" }],
      ["prefix が / で終わらない", { prefix: "lead" }],
    ];
    for (const [name, over] of cases) {
      test(`${name} は INVALID_ARGUMENT で、何も書かない`, async () => {
        const r = await refused(client.append(req(0, "x\n", over)));
        expect(r.code).toBe(Code.InvalidArgument);
        expect(await exists()).toBe(false);
      });
    }
  });

  test("S3 の GET で足した内容がそのまま読める", async () => {
    await client.append(req(0, "one\n"));
    await client.append(req(4, "two\n"));
    const res = await fetch(`http://127.0.0.1:${server.port}/ccx/${KEY}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("one\ntwo\n");
  });
});

describe("ObjectStore.append", () => {
  test("追記の途中で読んだ人には、追記前に確定していた長さまでしか見せない", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));

    // 追記の書き込みが始まって終わる前に読む。appendHold で書き込みの直後・確定の
    // 直前に止められる (テスト専用の継ぎ目)
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const pending = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);

    expect(await store.readCommitted("ccx", KEY)).toBe("one\n");
    expect((await store.head("ccx", KEY))?.size).toBe(4);

    release();
    expect(await pending).toEqual({ ok: true, size: 8n });
    expect(await store.readCommitted("ccx", KEY)).toBe("one\ntwo\n");
    expect((await store.head("ccx", KEY))?.size).toBe(8);
  });

  test("put と append は同じ key で交互に走らない (put の後の append は put の size に対して判定する)", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    await store.put("ccx", KEY, enc("one\ntwo\n"));
    expect(await store.append("ccx", KEY, 4n, enc("two\n"))).toEqual({ ok: false, size: 8n });
    expect(await store.append("ccx", KEY, 8n, enc("three\n"))).toEqual({ ok: true, size: 14n });
  });
});
