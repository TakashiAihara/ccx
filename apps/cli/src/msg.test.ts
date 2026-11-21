import { create } from "@bufbuild/protobuf";
import { afterEach, expect, test } from "bun:test";
import { createClient, createConnectRouter, Code, ConnectError } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeliveryMode, MessageService, SendResponseSchema, SendResponse_State, type SendRequest } from "@ccx/proto/ccx/v1/message_pb.ts";

import { ackLines, defaultApiSocketPath, defaultSender, failurePrefix, repoOf, sendMessage, senderMeta, unixTransport, WAIT_RAN_OUT } from "./msg.ts";

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
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition, { "Ccx-Not-Typed": "1" }))).toBe("not sent");
  expect(failurePrefix(new ConnectError("x", Code.Unknown))).toStartWith("may have been sent");
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition))).toStartWith("may have been sent");
  expect(failurePrefix(new ConnectError("x", Code.FailedPrecondition, { "Ccx-Not-Typed": "1" }), "sent")).toBe("sent, then lost the ack stream");
  expect(failurePrefix(new ConnectError("x", Code.Unknown), "queued")).toBe("queued, then lost the ack stream");
  const dir = mkdtempSync(join(tmpdir(), "ccx-msg-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const down = await sendMessage("t", "b", { mode: "urgent", summary: "s", from: "f", socket: join(dir, "none.sock") }, () => {}).catch((e) => e);
  expect(failurePrefix(down)).toBe("not sent");
});

test("a Devin sender is named from its herdr pane's session, which is what a reply is sent to (#334)", () => {
  const me = () => ({ username: "dev" });
  const devin = { agent: "devin", agent_session: { agent: "devin", kind: "id", source: "herdr:devin", value: "copper-python" } };
  const asked: string[] = [];
  expect(defaultSender({ HERDR_PANE_ID: "w1:p2" }, me, (id) => (asked.push(id), devin))).toBe("copper-python");
  expect(asked).toEqual(["w1:p2"]);

  // Claude Code goes first; another agent's pane, a pane with no session, or no answer from herdr falls back to user@host.
  const warned: string[] = [];
  const warn = (l: string) => warned.push(l);
  expect(defaultSender({ CLAUDE_CODE_SESSION_ID: "c1", HERDR_PANE_ID: "w1:p2" }, me, () => devin, warn)).toBe("c1");
  expect(defaultSender({ HERDR_PANE_ID: "w1:p2" }, me, () => ({ agent: "claude", agent_session: { agent: "devin", value: "x" } }), warn)).toStartWith("dev@");
  expect(defaultSender({ HERDR_PANE_ID: "w1:p2" }, me, () => ({ agent: "devin", agent_session: { agent: "claude", value: "x" } }), warn)).toStartWith("dev@");
  expect(defaultSender({ HERDR_PANE_ID: "w1:p2" }, me, () => ({ agent: "devin", agent_session: { agent: "devin", value: "" } }), warn)).toStartWith("dev@");
  expect(defaultSender({}, me, () => devin, warn)).toStartWith("dev@");
  // Only herdr giving no pane (missing, failed, hung, no pane in its answer) is said: a plain shell pane is not that.
  expect(warned).toEqual([]);
  expect(defaultSender({ HERDR_PANE_ID: "w1:p2" }, me, () => null, warn)).toStartWith("dev@");
  expect(warned).toEqual(["ccx: herdr did not say whose session pane w1:p2 is; sending as user@host, which cannot be replied to (pass --from)"]);
});

test("the Devin session name comes from `herdr pane get` on the env's PATH; a failing, hung or missing herdr falls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccx-herdr-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const me = () => ({ username: "dev" });
  const quiet = () => {};
  const env = { HERDR_PANE_ID: "w1:p2", PATH: dir };
  const fake = (script: string) => {
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "herdr"), 0o755);
  };

  fake(`[ "$1 $2 $3" = "pane get w1:p2" ] || exit 9\necho '{"id":"x","result":{"type":"pane","pane":{"agent":"devin","agent_session":{"agent":"devin","value":"copper-python"}}}}'`);
  expect(defaultSender(env, me, undefined, quiet)).toBe("copper-python");
  expect(defaultSender({ ...env, HERDR_PANE_ID: "w9:p9" }, me, undefined, quiet)).toStartWith("dev@");
  expect(defaultSender({ ...env, PATH: join(dir, "none") }, me, undefined, quiet)).toStartWith("dev@");

  // An answer from a herdr that failed is not taken, even if it reads as a pane.
  fake(`echo '{"result":{"pane":{"agent":"devin","agent_session":{"agent":"devin","value":"copper-python"}}}}'; exit 1`);
  expect(defaultSender(env, me, undefined, quiet)).toStartWith("dev@");

  fake(`echo 'not json'`);
  expect(defaultSender(env, me, undefined, quiet)).toStartWith("dev@");

  // A herdr that does not answer holds the send for 3 s, not for good, even one that ignores SIGTERM.
  fake(`trap '' TERM\nexec sleep 20`);
  const t0 = Date.now();
  expect(defaultSender(env, me, undefined, quiet)).toStartWith("dev@");
  expect(Date.now() - t0).toBeLessThan(6000);
}, 30000);

test("a sender outside Claude Code is user@host", () => {
  expect(defaultSender({})).toMatch(/^[^@\s]+@[^@\s]+$/);
});

async function runCli(args: string[], env: Record<string, string>, cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", join(import.meta.dir, "index.ts"), ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

test("the command says how far the acks got when the stream breaks after them", async () => {
  for (const [states, want] of [
    [[SendResponse_State.QUEUED], "queued, then lost the ack stream"],
    [[SendResponse_State.SENT], "sent, then lost the ack stream"],
    [[SendResponse_State.QUEUED, SendResponse_State.SENT], "sent, then lost the ack stream"],
  ] as const) {
    const socket = fakeAgent(async function* () {
      for (const state of states) yield { state };
      throw new ConnectError("gone", Code.Unknown);
    });
    const r = await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "--from", "me", "x"], {});
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${want}: gone`);
  }
});

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
  expect(failurePrefix(new ConnectError("x", Code.Unimplemented))).toBe("not sent");
  expect(failurePrefix(new ConnectError("x", Code.ResourceExhausted))).toBe("not sent");
});

test("a socket that refuses this user is not sent", () => {
  const byCode = new ConnectError("x", Code.Unknown, undefined, undefined, Object.assign(new Error("connect failed"), { code: "EACCES" }));
  expect(failurePrefix(byCode)).toBe("not sent");
  const byText = new ConnectError("x", Code.Unknown, undefined, undefined, new Error("ENOTSOCK: not a socket"));
  expect(failurePrefix(byText)).toBe("not sent");
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
  expect(ackLines(create(SendResponseSchema, { state: SendResponse_State.DONE, detail: "prompt p2" }))).toEqual(["done  prompt p2"]);
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
  // --wait 1 holds past 1 s (this fake answers late; a real agent stops watching at 1 s, but the typing comes first)
  await sendMessage("t", "b", { ...base, socket: slow(1100), wait: 1 }, (l) => lines.push(l));
  expect(lines).toEqual(["done", "  ok"]);
});

test("--wait takes whole seconds up to an hour", async () => {
  for (const bad of ["-1", "3601", "1.5", "x", "1e3", "0x10", " 5"]) {
    const r = await runCli(["msg", "send", "t", "--socket", "/nonexistent.sock", "--summary", "s", "--from", "me", "--wait", bad, "x"], {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--wait takes whole seconds from 0 to 3600");
  }
});

test("a --wait the agent says ran out is said and exits 3; a done, or no --wait, exits 0", async () => {
  const question = fakeAgent(async function* () {
    yield { state: SendResponse_State.SENT };
    yield { state: SendResponse_State.QUESTION, detail: "prompt p1" };
    yield { state: SendResponse_State.WAIT_ENDED };
  });
  const r = await runCli(["msg", "send", "t", "--socket", question, "--summary", "s", "--from", "me", "--wait", "5", "x"], {});
  expect([r.code, r.out]).toEqual([WAIT_RAN_OUT, "sent\nquestion  prompt p1\nno done within 5 s (the receiver may still be on it)\n"]);
  expect(WAIT_RAN_OUT).toBe(3);

  const done = fakeAgent(async function* () {
    yield { state: SendResponse_State.SENT };
    yield { state: SendResponse_State.DONE, text: "ok" };
  });
  const d = await runCli(["msg", "send", "t", "--socket", done, "--summary", "s", "--from", "me", "--wait", "5", "x"], {});
  expect([d.code, d.out]).toEqual([0, "sent\ndone\n  ok\n"]);

  // Without --wait the same acks are only acks.
  const plain = await runCli(["msg", "send", "t", "--socket", question, "--summary", "s", "--from", "me", "x"], {});
  expect([plain.code, plain.out]).toEqual([0, "sent\nquestion  prompt p1\nwait-ended\n"]);
});

// A Claude Code receiver has no turn to wait on (no question / done yet): its acks end as without --wait, and may
// take longer than a short --wait (up to about 10 s for not-started).
test("a --wait whose stream ends without the agent saying it ran out exits 0, however long it took", async () => {
  const claude = fakeAgent(async function* () {
    yield { state: SendResponse_State.SENT };
    await Bun.sleep(1100);
    yield { state: SendResponse_State.NOT_STARTED };
  });
  const r = await runCli(["msg", "send", "t", "--socket", claude, "--summary", "s", "--from", "me", "--wait", "1", "x"], {});
  expect([r.code, r.out]).toEqual([0, "sent\nnot-started\n"]);
});

test("--reply sends the msg_id for the agent to turn into the target, and every word is the body", async () => {
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT };
  });
  const r = await runCli(["msg", "send", "--reply", "870ca1f60db13297", "--socket", socket, "--summary", "re", "--from", "me", "reply", "received"], {});
  expect([r.code, r.out]).toEqual([0, "sent\n"]);
  expect([got?.replyTo, got?.target, got?.body, got?.machine, got?.user]).toEqual(["870ca1f60db13297", "", "reply received", "", ""]);

  const plain = await runCli(["msg", "send", "quick-kitten", "--socket", socket, "--summary", "s", "--from", "me", "hi", "there"], {});
  expect(plain.code).toBe(0);
  expect([got?.replyTo, got?.target, got?.body]).toEqual(["", "quick-kitten", "hi there"]);
});

test("--reply goes alone: with -m / -u, without a message, or with no target and no --reply, nothing is sent", async () => {
  let sent = 0;
  const socket = fakeAgent(async function* () {
    sent++;
    yield { state: SendResponse_State.SENT };
  });
  const base = ["msg", "send", "--socket", socket, "--summary", "s", "--from", "me"];
  for (const [args, why] of [
    [["--reply", "id1", "-m", "x", "hi"], "--reply takes the place of <target>, -m and -u"],
    [["--reply", "id1", "-u", "x", "hi"], "--reply takes the place of <target>, -m and -u"],
    [["--reply", "id1"], "give the message"],
    [["--reply", "", "word1", "word2"], "--reply needs a msg_id"],
    [["quick-kitten"], "give the message"],
    [[], "give <target>, or --reply <msg_id>"],
  ] as const) {
    const r = await runCli([...base, ...args], {});
    expect([r.code, r.err]).toEqual([1, expect.stringContaining(why)]);
  }
  expect(sent).toBe(0);
});

// Bun's fetch cuts a response that has been silent for about 6 minutes; a --wait on an unanswered question goes past that (#318).
test("the agent's stream is fetched with Bun's own timeout off", async () => {
  const real = globalThis.fetch;
  let seen: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: unknown, init?: Record<string, unknown>) => {
    seen = init;
    throw new Error("stop here");
  }) as unknown as typeof fetch;
  try {
    const client = createClient(MessageService, unixTransport("/nonexistent.sock"));
    await (async () => {
      for await (const _ of client.send({ target: "t" })) break;
    })().catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  expect(seen).toMatchObject({ unix: "/nonexistent.sock", timeout: false });
  expect(seen?.signal).toBeInstanceOf(AbortSignal);
});

const SID = "abcdef12-3456-4789-8abc-def012345678";

/** A checkout of octo/repo on feat/x, and a Claude Code home where SID declared label and role. */
function repoAndHome(label: string): { repo: string; home: string } {
  const repo = mkdtempSync(join(tmpdir(), "ccx-meta-repo-"));
  const home = mkdtempSync(join(tmpdir(), "ccx-meta-home-"));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }), () => rmSync(home, { recursive: true, force: true }));
  // The developer's own git config (url.insteadOf) must not change what `git remote get-url` says, here or in senderMeta.
  const saved = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  cleanups.push(() => {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved[0]], ["GIT_CONFIG_NOSYSTEM", saved[1]]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const env = { ...process.env };
  for (const args of [["init", "-q", "-b", "feat/x"], ["remote", "add", "origin", "https://github.com/octo/repo.git"]]) {
    expect(Bun.spawnSync(["git", "-C", repo, ...args], { env }).exitCode).toBe(0);
  }
  mkdirSync(join(home, "sessions", SID), { recursive: true });
  writeFileSync(join(home, "sessions", SID, "label"), label);
  writeFileSync(join(home, "sessions", SID, "role"), "impl\n");
  return { repo, home };
}

test("senderMeta says the session, cwd, repo, branch, label, role and the message it answers, then the --meta pairs", async () => {
  const { repo, home } = repoAndHome("reviewing #346\n");
  expect(await senderMeta({ auto: true, pairs: ["task=kaneo ccx#75", "a=x=y"], session: SID, reply: "m1", cwd: repo, home })).toEqual({
    from_session: SID, from_cwd: repo, from_repo: "octo/repo", from_branch: "feat/x",
    from_label: "reviewing #346", from_role: "impl", in_reply_to: "m1", meta_task: "kaneo ccx#75", meta_a: "x=y",
  });
  // Off: only the pairs. A label it cannot show, and a Devin sender's (no declared state), are left out.
  expect(await senderMeta({ auto: false, pairs: ["task=t"], session: SID, cwd: repo, home })).toEqual({ meta_task: "t" });
  const bad = repoAndHome("two\nlines");
  const m = await senderMeta({ auto: true, pairs: [], session: SID, cwd: bad.repo, home: bad.home });
  expect([m.from_label, m.from_role, m.in_reply_to]).toEqual([undefined, "impl", undefined]);
  const devin = await senderMeta({ auto: true, pairs: [], session: "quick-kitten", cwd: repo, home });
  expect([devin.from_session, devin.from_role]).toEqual(["quick-kitten", undefined]);
});

test("the command adds this session's meta unless --no-meta or [message] meta says no, and always the --meta pairs", async () => {
  const { repo, home } = repoAndHome("L");
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT };
  });
  const off = join(home, "off.toml");
  writeFileSync(off, "[message]\nmeta = false\n");
  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: home, CCX_CONFIG: join(home, "none.toml"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const send = (extra: string[], e: Record<string, string> = env) =>
    runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", ...extra, "hi"], e, repo);

  expect((await send(["--meta", "task=kaneo ccx#75"])).code).toBe(0);
  expect([got?.senderMeta.from_session, got?.senderMeta.from_repo, got?.senderMeta.from_label, got?.senderMeta.meta_task]).toEqual([SID, "octo/repo", "L", "kaneo ccx#75"]);
  for (const [extra, e] of [[["--meta", "task=x", "--no-meta"], env], [["--meta", "task=x"], { ...env, CCX_CONFIG: off }], [["--meta", "task=x"], { ...env, CCX_MESSAGE_META: "off" }]] as const) {
    expect((await send([...extra], e)).code).toBe(0);
    expect(got?.senderMeta).toEqual({ meta_task: "x" });
  }
  // The env turns it back on over the file.
  expect((await send([], { ...env, CCX_CONFIG: off, CCX_MESSAGE_META: "on" })).code).toBe(0);
  expect(got?.senderMeta.from_session).toBe(SID);

  const r = await send(["--meta", "Task=x"]);
  expect([r.code, r.err]).toEqual([1, expect.stringContaining("--meta takes key=value")]);
});

test("repoOf reads only the path, so no credentials leak, and agrees with ccx-agent's", () => {
  const cases: [string, string | undefined][] = [
    ["https://github.com/octo/repo.git", "octo/repo"],
    ["https://user:secret@git.example/repo.git", undefined],
    ["https://user:secret@git.example/octo/repo.git", "octo/repo"],
    ["ssh://git@host:2222/octo/repo.git", "octo/repo"],
    ["ssh://git@host/repo.git", undefined],
    ["git@host:octo/repo.git", "octo/repo"],
    ["host:repo.git", undefined],
    ["https://gitlab.example/group/sub/repo/", "sub/repo"],
    ["/srv/git/team/tool.git", "team/tool"],
    ["", undefined],
  ];
  expect(cases.map(([u]) => repoOf(u))).toEqual(cases.map(([, w]) => w));
});

test("--meta without = is refused, and an unreadable declaration does not stop the send", async () => {
  const { repo, home } = repoAndHome("L");
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT };
  });
  const env = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: home, CCX_CONFIG: join(home, "none.toml"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const r = await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "--meta", "task", "hi"], env, repo);
  expect([r.code, r.err]).toEqual([1, expect.stringContaining("--meta takes key=value")]);

  // A meta that is a file, not a directory, makes readDeclared throw (ENOTDIR, root or not).
  writeFileSync(join(home, "sessions", SID, "meta"), "");
  const ok = await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "hi"], env, repo);
  expect(ok.code).toBe(0);
  expect([got?.senderMeta.from_session, got?.senderMeta.from_label]).toEqual([SID, undefined]);
});

test("--reply says in_reply_to, and herdr is not asked when --from is given and meta is off", async () => {
  const { repo, home } = repoAndHome("L");
  let got: SendRequest | undefined;
  const socket = fakeAgent(async function* (req) {
    got = req;
    yield { state: SendResponse_State.SENT };
  });
  const env = { CLAUDE_CONFIG_DIR: home, CCX_CONFIG: join(home, "none.toml"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  expect((await runCli(["msg", "send", "--reply", "m9", "--socket", socket, "--summary", "s", "--from", "me", "ok"], { ...env, CLAUDE_CODE_SESSION_ID: SID }, repo)).code).toBe(0);
  expect([got?.replyTo, got?.senderMeta.in_reply_to]).toEqual(["m9", "m9"]);

  // A herdr that records being asked, first on PATH.
  const bin = mkdtempSync(join(tmpdir(), "ccx-herdr-asked-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "herdr"), `#!/bin/sh\ntouch ${join(bin, "asked")}\necho '{}'\n`);
  chmodSync(join(bin, "herdr"), 0o755);
  const inPane = { ...env, HERDR_PANE_ID: "w1:p1", PATH: `${bin}:${process.env.PATH ?? ""}` };
  expect((await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "--from", "me", "--no-meta", "x"], inPane, repo)).code).toBe(0);
  expect(await Bun.file(join(bin, "asked")).exists()).toBe(false);
  expect((await runCli(["msg", "send", "t", "--socket", socket, "--summary", "s", "--from", "me", "x"], inPane, repo)).code).toBe(0);
  expect(await Bun.file(join(bin, "asked")).exists()).toBe(true);
});
