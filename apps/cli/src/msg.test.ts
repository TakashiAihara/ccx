import { afterEach, expect, test } from "bun:test";
import { createConnectRouter, Code, ConnectError } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeliveryMode, MessageService, SendResponse_State, type SendRequest } from "@ccx/proto/ccx/v1/message_pb.ts";

import { defaultApiSocketPath, defaultSender, sendMessage } from "./msg.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Stands in for ccx-agent: serves MessageService on a unix socket. */
function fakeAgent(send: (req: SendRequest) => AsyncIterable<{ state: SendResponse_State; detail?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "ccx-msg-"));
  const socket = join(dir, "api.sock");
  const router = createConnectRouter();
  router.service(MessageService, { send: (req) => send(req) });
  const handlers = new Map(router.handlers.map((h) => [h.requestPath, createFetchHandler(h)]));
  const server = Bun.serve({
    unix: socket,
    fetch: (r) => handlers.get(new URL(r.url).pathname)?.(r) ?? new Response("no", { status: 404 }),
  });
  cleanups.push(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  return socket;
}

test("sends over the unix socket and prints each ack as it comes", async () => {
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT, detail: "pane w2:p1" };
    yield { state: SendResponse_State.WORKING };
  });
  const lines: string[] = [];
  await sendMessage("excited-giraffe", "fix it", { mode: "urgent", summary: "review 3", from: "claude-abc", socket }, (l) => lines.push(l));
  expect(lines).toEqual(["sent  pane w2:p1", "working"]);
  expect(got).toMatchObject({ target: "excited-giraffe", body: "fix it", summary: "review 3", sender: "claude-abc", mode: DeliveryMode.URGENT });
});

test("an unknown mode name sends nothing", async () => {
  let calls = 0;
  const socket = fakeAgent(async function* () {
    calls++;
    yield { state: SendResponse_State.SENT };
  });
  await expect(sendMessage("t", "b", { mode: "soon", summary: "s", from: "f", socket }, () => {})).rejects.toThrow("--mode must be one of later, after-turn, urgent");
  expect(calls).toBe(0);
});

test("the agent's refusal comes back with its reason", async () => {
  const socket = fakeAgent(async function* () {
    throw new ConnectError("excited-giraffe has text in its input box; nothing was sent", Code.FailedPrecondition);
  });
  const err = await sendMessage("t", "b", { mode: "after-turn", summary: "s", from: "f", socket }, () => {}).catch((e) => e);
  expect(err).toBeInstanceOf(ConnectError);
  expect(err.rawMessage).toBe("excited-giraffe has text in its input box; nothing was sent");
});

test("the API socket sits beside the hook socket unless CCX_API_SOCKET names one", () => {
  expect(defaultApiSocketPath({ XDG_RUNTIME_DIR: "/run/user/7" })).toBe("/run/user/7/ccx/ccx-api.sock");
  expect(defaultApiSocketPath({ XDG_RUNTIME_DIR: "/run/user/7", CCX_API_SOCKET: "/x/a.sock" })).toBe("/x/a.sock");
});

test("a Claude Code sender is named from its session id", () => {
  expect(defaultSender({ CLAUDE_CODE_SESSION_ID: "f61d5ded-df69-4683-aaa7-7ef078395a72" })).toBe("claude-f61d5ded");
});
