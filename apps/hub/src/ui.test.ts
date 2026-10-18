import { afterEach, beforeEach, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { createApp } from "./server.ts";

// 開き直す候補を選んで開く Web UI (#261)。ページは token 無しで返し、ページの JS が
// 人から受けた token を Bearer に付けて Connect の JSON で RPC を呼ぶ。
// ここで見るのは「ページが出ること」「ページ以外は今までどおり token が要ること」
// 「ページが送る JSON の形を center が受けること」。描画と操作はここでは見ない (ブラウザで確かめる)
const TOKEN = "ui-test-token-0123456789";
let server: ReturnType<typeof Bun.serve>;
let db: Db;
let objectsDir: string;
let base: string;

beforeEach(async () => {
  db = openDb(":memory:");
  objectsDir = await mkdtemp(join(tmpdir(), "ccx-ui-objects-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(objectsDir), { token: TOKEN }).fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await rm(objectsDir, { recursive: true, force: true });
});

const rpc = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test("GET /ui returns the page without a token, and the page calls the three RPCs it needs", async () => {
  const res = await fetch(`${base}/ui`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("ccx.v1.FleetService/ListSessions");
  expect(html).toContain("ccx.v1.ResumeService/RequestResume");
  expect(html).toContain("ccx.v1.ResumeService/ListResumeRequests");
  expect(html).toContain("stoppedOnly");
  // the first list can take seconds; the page says it is loading rather than show an empty table
  expect(html).toContain("loading...");
});

// ページの中の script は 1 つだけ。テストはそれを取り出して、構文と CSP のハッシュを確かめる
async function pageScript() {
  const html = await (await fetch(`${base}/ui`)).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts).toHaveLength(1);
  return { html, script: scripts[0]! };
}

function directives(csp: string) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name!, values]),
  );
}

test("the page's script parses", async () => {
  const { script } = await pageScript();
  expect(() => new Function(script)).not.toThrow();
});

test("the page may talk only to the center itself, and runs only its own script", async () => {
  const csp = (await fetch(`${base}/ui`)).headers.get("content-security-policy") ?? "";
  const d = directives(csp);
  expect(d["default-src"]).toEqual(["'none'"]);
  expect(d["connect-src"]).toEqual(["'self'"]);
  // 'unsafe-inline' ではなく、この 1 つの script のハッシュだけを許す
  const { script } = await pageScript();
  const hash = new Bun.CryptoHasher("sha256").update(script).digest("base64");
  expect(d["script-src"]).toEqual([`'sha256-${hash}'`]);
});

test("only GET and HEAD of /ui itself skip the token", async () => {
  expect((await fetch(`${base}/ui`, { method: "HEAD" })).status).toBe(200);
  expect((await fetch(`${base}/ui`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${base}/ui/x`)).status).toBe(401);
  expect((await rpc("ccx.v1.FleetService/ListSessions", { stoppedOnly: true })).status).toBe(401);
});

test("the JSON the page sends is what the center reads", async () => {
  // ページが送るのと同じ上限で呼ぶ。ページ側の値はページから読む
  const { html } = await pageScript();
  const limit = Number(/const LIST_LIMIT = (\d+);/.exec(html)?.[1]);
  expect(limit).toBe(500);
  expect(html).toContain("{ stoppedOnly: true, limit: LIST_LIMIT }");
  const list = await rpc("ccx.v1.FleetService/ListSessions", { stoppedOnly: true, limit }, TOKEN);
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({});

  const key = { machine: "m1", user: "u1", sessionId: "11111111-2222-3333-4444-555555555555" };
  const put = await rpc("ccx.v1.ResumeService/RequestResume", { key, waitSeconds: 40 }, TOKEN);
  expect(put.status).toBe(200);
  const { request } = (await put.json()) as { request: { id: string; key: typeof key } };
  expect(request.key).toEqual(key);

  // ページは条件を付けずに新しい順の依頼を読み、行の状態もそこから決める
  const recent = Number(/const RECENT_LIMIT = (\d+);/.exec(html)?.[1]);
  expect(recent).toBe(50);
  expect(html).toContain("{ limit: RECENT_LIMIT }");
  const got = await rpc("ccx.v1.ResumeService/ListResumeRequests", { limit: recent }, TOKEN);
  const { requests } = (await got.json()) as { requests: { id: string; claimToken?: string }[] };
  expect(requests.map((r) => r.id)).toEqual([request.id]);
  expect(requests[0]!.claimToken ?? "").toBe("");
});
