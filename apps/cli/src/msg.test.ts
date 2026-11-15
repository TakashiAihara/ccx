import { create } from "@bufbuild/protobuf";
import { afterEach, expect, test } from "bun:test";
import { createConnectRouter, Code, ConnectError } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeliveryMode, MessageService, SendResponseSchema, SendResponse_State, type SendRequest } from "@ccx/proto/ccx/v1/message_pb.ts";

import { ackLines, defaultApiSocketPath, defaultSender, failurePrefix, sendMessage } from "./msg.ts";

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
  expect(defaultSender({ CLAUDE_CODE_SESSION_ID: "f61d5ded-df69-4683-aaa7-7ef078395a72" })).toBe("f61d5ded-df69-4683-aaa7-7ef078395a72");
});

test("only a failure marked not typed, or an unreachable agent, is called not sent", async () => {
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition, { "Ccx-Not-Typed": "1" }), 0)).toBe("not sent");
  expect(failurePrefix(new ConnectError("x", Code.Unknown), 0)).toStartWith("may have been sent");
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition), 0)).toStartWith("may have been sent");
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition, { "Ccx-Not-Typed": "1" }), 1)).toBe("sent, then lost the ack stream");
  const dir = mkdtempSync(join(tmpdir(), "ccx-msg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const down = await sendMessage("t", "b", { mode: "urgent", summary: "s", from: "f", socket: join(dir, "none.sock") }, () => {}).catch((e) => e);
  expect(failurePrefix(down, 0)).toBe("not sent");
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
  expect(got).toMatchObject({ sender: "f61d5ded-df69-4683-aaa7-7ef078395a72", body: "fix it", mode: DeliveryMode.AFTER_TURN });
});

test("the command says not sent for a refusal and exits 1", async () => {
  const socket = fakeAgent(async function* () {
    throw new ConnectError("no herdr pane has session", Code.NotFound, { "Ccx-Not-Typed": "1" });
  });
  const r = await runCli(["msg", "send", "nobody", "--socket", socket, "--summary", "s", "--from", "me", "x"], {});
  expect(r.code).toBe(1);
  expect(r.err).toContain("not sent: no herdr pane has session");
});

test("the command says may have been sent for a failure not marked as untyped", async () => {
  const socket = fakeAgent(async function* () {
    throw new ConnectError("herdr took the prompt but it was not seen as sent", Code.Unknown);
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

test("a uid with no passwd entry still gets a sender name", () => {
  const throws = () => {
    throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
  };
  expect(defaultSender({ USER: "ci" }, throws)).toMatch(/^ci@/);
  expect(defaultSender({}, throws)).toMatch(/^uid\d*@/);
});

test("an older ccx-agent without the service, or an oversized request, is not sent", () => {
  expect(failurePrefix(new ConnectError("x", Code.Unimplemented), 0)).toBe("not sent");
  expect(failurePrefix(new ConnectError("x", Code.ResourceExhausted), 0)).toBe("not sent");
});

test("a socket that refuses this user is not sent", () => {
  const byCode = new ConnectError("x", Code.Unknown, undefined, undefined, Object.assign(new Error("connect failed"), { code: "EACCES" }));
  expect(failurePrefix(byCode, 0)).toBe("not sent");
  const byText = new ConnectError("x", Code.Unknown, undefined, undefined, new Error("ENOTSOCK: not a socket"));
  expect(failurePrefix(byText, 0)).toBe("not sent");
});

test("--timeout must be a positive number", async () => {
  for (const bad of ["abc", "-5", "0"]) {
    const r = await runCli(["msg", "send", "t", "--socket", "/nonexistent.sock", "--summary", "s", "--from", "me", "--timeout", bad, "x"], {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--timeout takes a positive number of milliseconds");
  }
});

test("a default sender is cut to the 40 bytes ccx-agent takes", () => {
  const name = defaultSender({}, () => ({ username: "u".repeat(60) }));
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(40);
  expect(name).toBe("u".repeat(40));
});

test("--machine and --user are passed on for ccx-agent to relay; left out, they are empty (here)", async () => {
  const got: SendRequest[] = [];
  const socket = fakeAgent(async function* (req) {
    got.push(req);
    yield { state: SendResponse_State.SENT };
  });
  await sendMessage("t", "b", { mode: "urgent", summary: "s", from: "f", socket, machine: "ccx1", user: "dev" }, () => {});
  await sendMessage("t", "b", { mode: "urgent", summary: "s", from: "f", socket }, () => {});
  expect(got.map((r) => [r.machine, r.user])).toEqual([
    ["ccx1", "dev"],
    ["", ""],
  ]);
});

test("the command takes -m and -u", async () => {
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT };
  });
  const r = await runCli(["msg", "send", "t", "-m", "ccx1", "-u", "dev", "--socket", socket, "--summary", "s", "b"], {});
  expect(r.code).toBe(0);
  expect(got).toMatchObject({ machine: "ccx1", user: "dev" });
});

test("-m alone leaves the user for ccx-agent to fill, and -u alone the machine", async () => {
  const got: SendRequest[] = [];
  const socket = fakeAgent(async function* (req) {
    got.push(req);
    yield { state: SendResponse_State.SENT };
  });
  await runCli(["msg", "send", "t", "-m", "ccx1", "--socket", socket, "--summary", "s", "b"], {});
  await runCli(["msg", "send", "t", "-u", "dev", "--socket", socket, "--summary", "s", "b"], {});
  expect(got.map((r) => [r.machine, r.user])).toEqual([
    ["ccx1", ""],
    ["", "dev"],
  ]);
});

test("a question lists its options and done carries the last answer indented", () => {
  const q = create(SendResponseSchema, {
    state: SendResponse_State.QUESTION,
    detail: "prompt p1",
    questions: [
      { header: "好きな果物", question: "どちら？", options: [{ label: "りんご", description: "りんごを選ぶ" }, { label: "みかん" }] },
      { question: "理由は？", options: [] },
    ],
  });
  expect(ackLines(q)).toEqual(["question  prompt p1", "  好きな果物: どちら？", "    - りんご (りんごを選ぶ)", "    - みかん", "  理由は？"]);
  const d = create(SendResponseSchema, { state: SendResponse_State.DONE, text: "了解\n2 行目" });
  expect(ackLines(d)).toEqual(["done", "  了解", "  2 行目"]);
  expect(ackLines(create(SendResponseSchema, { state: SendResponse_State.QUEUED, detail: "next turn" }))).toEqual(["queued  next turn"]);
});

test("--wait is passed on and outlasts the timeout", async () => {
  let wait: number | undefined;
  const socket = fakeAgent(async function* (req) {
    wait = req.waitSeconds;
    await Bun.sleep(150);
    yield { state: SendResponse_State.DONE, text: "ok" };
  });
  const lines: string[] = [];
  // A 50 ms timeout alone would cut the 150 ms answer; the wait keeps the stream for wait + 60 s.
  await sendMessage("t", "b", { mode: "urgent", summary: "s", from: "f", socket, timeout: 50, wait: 30 }, (l) => lines.push(l));
  expect(wait).toBe(30);
  expect(lines).toEqual(["done", "  ok"]);
});

test("without --wait the timeout is the timeout; with it, the wait gets a minute on top", async () => {
  const slow = (ms: number) =>
    fakeAgent(async function* () {
      await Bun.sleep(ms);
      yield { state: SendResponse_State.DONE, text: "ok" };
    });
  const lines: string[] = [];
  const base = { mode: "urgent", summary: "s", from: "f", timeout: 50 };
  // 50 ms cuts a 150 ms answer when nothing asked to wait
  expect(await sendMessage("t", "b", { ...base, socket: slow(150) }, (l) => lines.push(l)).catch((e: unknown) => e)).toBeInstanceOf(Error);
  // --wait 1 holds past 1 s: the typing part comes before the wait
  await sendMessage("t", "b", { ...base, socket: slow(1100), wait: 1 }, (l) => lines.push(l));
  expect(lines).toEqual(["done", "  ok"]);
});

test("--wait takes whole seconds up to an hour", async () => {
  for (const bad of ["-1", "3601", "1.5", "x"]) {
    const r = await runCli(["msg", "send", "t", "--socket", "/nonexistent.sock", "--summary", "s", "--from", "me", "--wait", bad, "x"], {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--wait takes whole seconds from 0 to 3600");
  }
});
