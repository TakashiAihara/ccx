import { afterEach, expect, test } from "bun:test";
import { createConnectRouter, Code, ConnectError } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeliveryMode, MessageService, SendResponse_State, type SendRequest } from "@ccx/proto/ccx/v1/message_pb.ts";

import { defaultApiSocketPath, defaultSender, failurePrefix, sendMessage } from "./msg.ts";

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

test("only a failure after typing is called may have been sent", () => {
  expect(failurePrefix(new ConnectError("x", Code.Unknown), 0)).toBe("not sent");
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition), 0)).toBe("not sent");
  expect(failurePrefix(new ConnectError("x", Code.Unknown, { "Ccx-Typed": "1" }), 0)).toStartWith("may have been sent");
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition), 1)).toBe("sent, then lost the ack stream");
});

test("a sender outside Claude Code is user@host", () => {
  expect(defaultSender({})).toMatch(/^[^@\s]+@[^@\s]+$/);
});

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", join(import.meta.dir, "index.ts"), ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

test("the command names a Claude Code sender from its session and prints acks", async () => {
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT, detail: "pane w2:p1" };
  });
  const r = await runCli(["msg", "send", "excited-giraffe", "--socket", socket, "--summary", "s", "fix", "it"], { CLAUDE_CODE_SESSION_ID: "f61d5ded-df69-4683-aaa7-7ef078395a72" });
  expect(r).toMatchObject({ code: 0, out: "sent  pane w2:p1\n" });
  expect(got).toMatchObject({ sender: "claude-f61d5ded", body: "fix it", mode: DeliveryMode.AFTER_TURN });
});

test("the command says not sent for a refusal and exits 1", async () => {
  const socket = fakeAgent(async function* () {
    throw new ConnectError("no herdr pane has session", Code.NotFound);
  });
  const r = await runCli(["msg", "send", "nobody", "--socket", socket, "--summary", "s", "--from", "me", "x"], {});
  expect(r.code).toBe(1);
  expect(r.err).toContain("not sent: no herdr pane has session");
});

test("the command says may have been sent for a failure marked typed", async () => {
  const socket = fakeAgent(async function* () {
    throw new ConnectError("herdr took the prompt but it was not seen as sent", Code.Unknown, { "Ccx-Typed": "1" });
  });
  const r = await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "--from", "me", "x"], {});
  expect(r.code).toBe(1);
  expect(r.err).toContain("may have been sent (look at the receiver before sending again): herdr took the prompt");
});

test("later maps to LATER and not-started is printed by name", async () => {
  let mode: DeliveryMode | undefined;
  const socket = fakeAgent(async function* (req) {
    mode = req.mode;
    yield { state: SendResponse_State.SENT };
    yield { state: SendResponse_State.NOT_STARTED, detail: "no sign" };
  });
  const lines: string[] = [];
  await sendMessage("t", "b", { mode: "later", summary: "s", from: "f", socket }, (l) => lines.push(l));
  expect(mode).toBe(DeliveryMode.LATER);
  expect(lines).toEqual(["sent", "not-started  no sign"]);
});

test("a mode name that is an Object property is still unknown", async () => {
  await expect(sendMessage("t", "b", { mode: "toString", summary: "s", from: "f", socket: "/nonexistent.sock" }, () => {})).rejects.toThrow("--mode must be one of");
});

test("an explicit empty --from is passed on for ccx-agent to refuse, not replaced", async () => {
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT };
  });
  await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "--from", "", "x"], { CLAUDE_CODE_SESSION_ID: "f61d5ded-df69-4683-aaa7-7ef078395a72" });
  expect(got?.sender).toBe("");
});
