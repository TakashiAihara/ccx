import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
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
      ["組んだ key が 1024 文字を超える", { prefix: "abcd/".repeat(200) }],
    ];
    for (const [name, over] of cases) {
      test(`${name} は INVALID_ARGUMENT で、どこにも何も書かない`, async () => {
        const r = await refused(client.append(req(0, "x\n", over)));
        expect(r.code).toBe(Code.InvalidArgument);
        // 既定の key だけでなく、変えた先にも書いていないこと
        const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
        expect(files.map((e) => e.name)).toEqual([]);
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

    expect(await (await store.snapshot("ccx", KEY))?.body.text()).toBe("one\n");
    expect((await store.head("ccx", KEY))?.size).toBe(4);

    release();
    expect(await pending).toEqual({ ok: true, size: 8n });
    expect(await (await store.snapshot("ccx", KEY))?.body.text()).toBe("one\ntwo\n");
    expect((await store.head("ccx", KEY))?.size).toBe(8);
  });

  test("put の後の append は put の size に対して判定する", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    await store.put("ccx", KEY, enc("one\ntwo\n"));
    expect(await store.append("ccx", KEY, 4n, enc("two\n"))).toEqual({ ok: false, size: 8n });
    expect(await store.append("ccx", KEY, 8n, enc("three\n"))).toEqual({ ok: true, size: 14n });
  });
});

describe("ObjectStore.append の費用", () => {
  test("size の判定に head を使わない (head は object 全体の md5 を読むので、追記のたびに全体を読むことになる)", async () => {
    class NoHead extends ObjectStore {
      override async head(): Promise<never> {
        throw new Error("append read the whole object through head()");
      }
    }
    const store = new NoHead(root);
    expect(await store.append("ccx", KEY, 0n, enc("one\n"))).toEqual({ ok: true, size: 4n });
    expect(await store.append("ccx", KEY, 0n, enc("one\n"))).toEqual({ ok: false, size: 4n });
    expect(await store.append("ccx", KEY, 4n, enc("two\n"))).toEqual({ ok: true, size: 8n });
  });

  test("一覧の size も、追記の途中は確定した長さまで", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const pending = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);
    const listed = (await store.listKeys("ccx", "transcripts/")).find((o) => o.key === KEY);
    expect(listed?.size).toBe(4);
    release();
    await pending;
  });
});

describe("ObjectStore.snapshot", () => {
  test("snapshot の本文は head の長さで切れる (取った後に追記が確定しても伸びない)", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const pending = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);

    const snap = await store.snapshot("ccx", KEY);
    release();
    await pending;

    expect(snap?.head.size).toBe(4);
    expect(await snap?.body.text()).toBe("one\n");
  });

  test("無い object は null", async () => {
    expect(await new ObjectStore(root).snapshot("ccx", KEY)).toBeNull();
  });
});

describe("ObjectStore: 同じ key への書き込みの並び", () => {
  test("追記の途中に来た DELETE は追記が終わってから消す (追記が空のファイルを作り直さない)", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const appending = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);

    const deleting = store.delete("ccx", KEY);
    await Bun.sleep(20);
    expect(await exists()).toBe(true);

    release();
    expect(await appending).toEqual({ ok: true, size: 8n });
    await deleting;
    expect(await exists()).toBe(false);
    // 消えた後の追記は size 0 を返して断る (欠けを作らない)
    expect(await store.append("ccx", KEY, 8n, enc("three\n"))).toEqual({ ok: false, size: 0n });
  });

  test("本文を受け取り途中の put は追記を止めない。put の置き換えは追記の後に入る", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc("one\ntwo\n"));
        await gate;
        c.enqueue(enc("three\n"));
        c.close();
      },
    });
    const putting = store.put("ccx", KEY, body);
    await Bun.sleep(20);

    // put が本文を待っている間に来た追記は、put を待たずに済む
    expect(await store.append("ccx", KEY, 4n, enc("late\n"))).toEqual({ ok: true, size: 9n });
    release();
    await putting;
    // 置き換えは put の写し。送り手 (agent) は次の追記で断られ、put の size から続ける
    expect(await stored()).toBe("one\ntwo\nthree\n");
    expect(await store.append("ccx", KEY, 9n, enc("x\n"))).toEqual({ ok: false, size: 14n });
  });

  test("追記に失敗したら、追記前の長さに切り戻して投げる", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    await expect(
      store.append("ccx", KEY, 4n, enc("two\n"), {
        beforeCommit: async () => {
          throw new Error("disk went away");
        },
      }),
    ).rejects.toThrow("disk went away");
    expect(await stored()).toBe("one\n");
    expect((await store.head("ccx", KEY))?.size).toBe(4);
  });
});

describe("ObjectStore.head と追記の競合", () => {
  test("追記の書き込み途中の長さを stat で読み、その後に追記が確定しても、書きかけの長さを返さない", async () => {
    // stat が書き込みの途中 (4 + 2 bytes) を読み、head が確定長を見る前に追記が確定する。
    // 確定長の記録はもう消えているので、stat の値をそのまま使うと行の途中で切れる
    let release!: () => void;
    let committed!: Promise<unknown>;
    let first = true;
    class MidWrite extends ObjectStore {
      protected override async statOf(path: string) {
        const s = await super.statOf(path);
        if (!first) return s;
        first = false;
        release();
        await committed;
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 6 });
      }
    }
    const store = new MidWrite(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    const held = new Promise<void>((r) => (release = r));
    committed = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);

    const h = await store.head("ccx", KEY);
    expect(h?.size).toBe(8);
  });
});

describe("Append の expected_tail", () => {
  test("object の末尾が送り手の直前の bytes と一致すれば足す", async () => {
    await client.append(req(0, "one\ntwo\n"));
    const res = await client.append(req(8, "three\n", { expectedTail: enc("two\n") }));
    expect(res.size).toBe(14n);
  });

  test("一致しなければ書かずに DATA_LOSS (別の写しを継ぎ足さない)", async () => {
    await client.append(req(0, "one\ntwo\n"));
    const r = await refused(client.append(req(8, "three\n", { expectedTail: enc("TWO\n") })));
    expect(r.code).toBe(Code.DataLoss);
    expect(await stored()).toBe("one\ntwo\n");
  });

  test("object より長い expected_tail も DATA_LOSS", async () => {
    await client.append(req(0, "x\n"));
    const r = await refused(client.append(req(2, "y\n", { expectedTail: enc("abc\nx\n") })));
    expect(r.code).toBe(Code.DataLoss);
    expect(await stored()).toBe("x\n");
  });

  test("offset が size と違えば、expected_tail を見る前に size を返して断る", async () => {
    await client.append(req(0, "one\n"));
    const r = await refused(client.append(req(0, "one\n", { expectedTail: enc("zzz") })));
    expect(r).toEqual({ code: Code.FailedPrecondition, size: 4n });
  });
});

describe("ObjectStore: put の置き換えと追記の順序", () => {
  test("追記の確定前に put の置き換えは入らない (追記の size 判定と書き込みの間で object が差し替わらない)", async () => {
    const store = new ObjectStore(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const appending = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);

    const putting = store.put("ccx", KEY, enc("new\n"));
    await Bun.sleep(20);
    expect(await stored()).toBe("one\ntwo\n");

    release();
    await appending;
    await putting;
    expect(await stored()).toBe("new\n");
  });
});

describe("ObjectStore: 切り戻しの最中と一覧", () => {
  test("追記の切り戻しの最中に読んでも、書きかけの長さは見えない", async () => {
    let during: number | undefined;
    class SlowRollback extends ObjectStore {
      protected override async truncateTo(path: string, size: number) {
        during = (await this.head("ccx", KEY))?.size;
        await super.truncateTo(path, size);
      }
    }
    const store = new SlowRollback(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    await expect(
      store.append("ccx", KEY, 4n, enc("two\n"), {
        beforeCommit: async () => {
          throw new Error("disk went away");
        },
      }),
    ).rejects.toThrow("disk went away");
    expect(during).toBe(4);
  });

  test("一覧も、stat の後に追記が確定したとき書きかけの長さを返さない", async () => {
    let release!: () => void;
    let committed!: Promise<unknown>;
    let armed = false;
    class MidWrite extends ObjectStore {
      protected override async statOf(path: string) {
        const s = await super.statOf(path);
        if (!armed) return s;
        armed = false;
        release();
        await committed;
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 6 });
      }
    }
    const store = new MidWrite(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));
    const held = new Promise<void>((r) => (release = r));
    committed = store.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
    await Bun.sleep(20);

    armed = true;
    const listed = (await store.listKeys("ccx", "transcripts/")).find((o) => o.key === KEY);
    expect(listed?.size).toBe(8);
  });
});

describe("ObjectStore.head: 確定長を読んだ後に追記が始まる", () => {
  test("stat が書き込み途中の長さを読んでも、それを返さない (確定前の 4 を返す)", async () => {
    let release!: () => void;
    let appending: Promise<unknown> | undefined;
    let armed = false;
    class StartsDuringStat extends ObjectStore {
      protected override async statOf(path: string) {
        if (!armed) return super.statOf(path);
        armed = false;
        // head が確定長 (記録なし) を読んだ後、stat が返る前に追記が始まり、2 bytes 書けた瞬間を stat が読む
        const held = new Promise<void>((r) => (release = r));
        appending = this.append("ccx", KEY, 4n, enc("two\n"), { beforeCommit: () => held });
        await Bun.sleep(10);
        const s = await super.statOf(path);
        return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 6 });
      }
    }
    const store = new StartsDuringStat(root);
    await store.append("ccx", KEY, 0n, enc("one\n"));

    armed = true;
    const h = await store.head("ccx", KEY);
    release();
    await appending;
    // 追記の確定 (release) は head が返った後なので、head が返せる正しい長さは 4 だけ
    expect(h?.size).toBe(4);
  });
});
