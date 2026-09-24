import { afterEach, expect, test } from "bun:test";

import { fleetClient, unreachable } from "./fleet.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => void server?.stop(true));

/** 届いた Authorization を記録するだけの相手。応答の中身は見ない (呼び出しは失敗してよい) */
async function seenAuthorization(token?: string): Promise<string | null> {
  let seen: string | null = "not called";
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen = req.headers.get("authorization");
      return new Response("", { status: 401 });
    },
  });
  await fleetClient({ url: `http://127.0.0.1:${server.port}`, ...(token ? { token } : {}) })
    .listSessions({})
    .catch(() => undefined);
  return seen;
}

test("token があれば center への要求に Bearer で付ける (#158)", async () => {
  expect(await seenAuthorization("tok-for-test")).toBe("Bearer tok-for-test");
});

test("token が無ければ Authorization を送らない", async () => {
  expect(await seenAuthorization()).toBeNull();
});

test("401 は「届かない」ではなく token を名指しする", async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("", { status: 401 }) });
  const url = `http://127.0.0.1:${server.port}`;
  const err = await fleetClient({ url }).listSessions({}).catch((e) => e);
  expect(unreachable(url, err).message).toContain("refused the token");
  expect(unreachable(url, new Error("ECONNREFUSED")).message).toContain("did not answer");
});
