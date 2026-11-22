import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { afterEach, expect, test } from "bun:test";
import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { AgentService, HeartbeatStatusSchema, type GetSessionStatusRequest, type HeartbeatStatus } from "@ccx/proto/ccx/v1/agent_pb.ts";

import { keepaliveLine, keepaliveState, keepaliveSummary, sessionAgentStatus } from "./keepalive.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const SID2 = "1f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (min: number) => timestampFromDate(new Date(NOW - min * 60_000));

/** A registered session on an agent whose heartbeat is on; each case overrides what it is about. */
const hb = (o: MessageInitShape<typeof HeartbeatStatusSchema> = {}): HeartbeatStatus =>
  create(HeartbeatStatusSchema, { enabled: true, listening: true, wanted: true, registered: true, ...o });

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stands in for ccx-agent: answers AgentService.GetSessionStatus on a unix socket. */
function fakeAgent(answer: (req: GetSessionStatusRequest) => MessageInitShape<typeof HeartbeatStatusSchema>): string {
  const socket = join(tmp("ccx-keepalive-"), "api.sock");
  const router = createConnectRouter();
  router.service(AgentService, { getSessionStatus: (req) => ({ heartbeat: hb(answer(req)), collect: { enabled: true, pending: 4 } }) });
  const handlers = new Map(router.handlers.map((h) => [h.requestPath, createFetchHandler(h)]));
  const server = Bun.serve({
    unix: socket,
    fetch: (r) => handlers.get(new URL(r.url).pathname)?.(r) ?? new Response("no", { status: 404 }),
  });
  cleanups.push(() => server.stop(true));
  return socket;
}

test("the state is the first thing that stops a beat: the agent, its config, its socket, the channel, then the agent's own reason", () => {
  expect(keepaliveState(undefined)).toBe("unknown");
  expect(keepaliveState(hb({ enabled: false, listening: false, registered: false }))).toBe("off");
  expect(keepaliveState(hb({ listening: false, registered: false }))).toBe("not listening");
  expect(keepaliveState(hb({ registered: false }))).toBe("not registered");
  // An unregistered session the declaration turned off is not waiting for a channel.
  expect(keepaliveState(hb({ registered: false, wanted: false }))).toBe("not_wanted");
  expect(keepaliveState(hb({ nextAt: ago(-20) }))).toBe("scheduled");
  expect(keepaliveState(hb({ idleReason: "short_ttl" }))).toBe("short_ttl");
  expect(keepaliveState(hb({ idleReason: "beat_pending" }))).toBe("beat_pending");
  // An agent from before the reasons existed: registered, nothing due, nothing said.
  expect(keepaliveState(hb())).toBe("not scheduled");
});

test("the line says the state, then the cache TTL, the last beat and the beats since the last prompt when there are any", () => {
  expect(keepaliveLine(hb({ nextAt: ago(-20), cacheTtl: "1h" }), NOW)).toBe("next in 20m, 1h cache");
  expect(keepaliveLine(hb({ idleReason: "short_ttl", cacheTtl: "5m", lastBeatAt: ago(120), beatsSinceReal: 7 }), NOW)).toBe(
    "short_ttl, 5m cache, last beat 2h ago, 7 beats since the last prompt",
  );
  expect(keepaliveLine(hb({ idleReason: "beat_pending", cacheTtl: "1h", lastBeatAt: ago(50), beatsSinceReal: 1 }), NOW)).toBe(
    "beat_pending, 1h cache, last beat 50m ago, 1 beat since the last prompt",
  );
  expect(keepaliveLine(hb({ idleReason: "no_request" }), NOW)).toBe("no_request");
  expect(keepaliveLine(undefined, NOW)).toBe("unknown (ccx-agent is not answering)");
  expect(keepaliveLine(hb({ enabled: false, listening: false, registered: false }), NOW)).toBe("off (heartbeat is off in ccx-agent's config)");
  expect(keepaliveLine(hb({ listening: false, registered: false }), NOW)).toBe("not listening (ccx-agent could not open its channel socket)");
  expect(keepaliveLine(hb({ registered: false }), NOW)).toBe("not registered (no channel to push a heartbeat through)");
});

test("the summary counts sessions by state, scheduled first, then by name", () => {
  expect(keepaliveSummary([])).toBe("no running sessions");
  expect(
    keepaliveSummary([
      hb({ idleReason: "short_ttl" }),
      hb({ nextAt: ago(-5) }),
      hb({ registered: false }),
      hb({ idleReason: "short_ttl" }),
      hb({ idleReason: "expired" }),
      hb({ nextAt: ago(-9) }),
      hb({ idleReason: "short_ttl" }),
      undefined,
    ]),
  ).toBe("2 scheduled, 1 expired, 1 not registered, 3 short_ttl, 1 unknown");
});

test("asks ccx-agent over the unix socket with the session's id and home; a socket nobody answers is undefined, not an error", async () => {
  let got: GetSessionStatusRequest | undefined;
  const socket = fakeAgent((req) => {
    got = req;
    return { idleReason: "expired", cacheTtl: "1h" };
  });
  const res = await sessionAgentStatus(socket, SID, "/home/x/.claude");
  expect(got).toMatchObject({ sessionId: SID, claudeHome: "/home/x/.claude" });
  expect(res?.heartbeat).toMatchObject({ registered: true, idleReason: "expired", cacheTtl: "1h" });
  expect(res?.collect?.pending).toBe(4);

  expect(await sessionAgentStatus(join(tmp("ccx-keepalive-none-"), "none.sock"), SID, "/home/x/.claude")).toBeUndefined();

  // The agent takes a relative home as its own default: the CLI's relative CLAUDE_CONFIG_DIR goes absolute.
  await sessionAgentStatus(socket, SID, "rel/.claude");
  expect(got?.claudeHome).toBe(resolve("rel/.claude"));
});

test("an agent that accepts the connection and never answers is given up on, not waited for", async () => {
  const socket = join(tmp("ccx-keepalive-wedged-"), "api.sock");
  const server = Bun.serve({ unix: socket, fetch: () => new Promise<Response>(() => {}) });
  cleanups.push(() => server.stop(true));
  const started = Date.now();
  expect(await sessionAgentStatus(socket, SID, "/home/x/.claude")).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(5000);
}, 20_000);

const cli = join(import.meta.dir, "index.ts");

async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...process.env, CCX_HUB_URL: "", XDG_CONFIG_HOME: tmp("ccx-keepalive-cfg-"), CCX_CONFIG: "/nonexistent/ccx.toml", CLAUDE_CODE_SESSION_ID: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

/** A Claude Code home where each id has a transcript and a pid file naming a live process (this one, then its parent): running sessions. */
function homeWithRunningSessions(...ids: string[]): string {
  const home = tmp("ccx-keepalive-home-");
  mkdirSync(join(home, "projects", "-w"), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  const pids = [process.pid, process.ppid];
  ids.forEach((id, i) => {
    writeFileSync(join(home, "projects", "-w", `${id}.jsonl`), `${JSON.stringify({ type: "user", cwd: "/w", message: "hi" })}\n`);
    writeFileSync(join(home, "sessions", `${pids[i]}.json`), JSON.stringify({ pid: pids[i], sessionId: id }));
  });
  return home;
}

test("ccx session status shows the keepalive line and carries the agent's answer in --json; with no agent it says unknown", async () => {
  const home = homeWithRunningSessions(SID);
  let answer: MessageInitShape<typeof HeartbeatStatusSchema> = { idleReason: "short_ttl", cacheTtl: "5m", beatsSinceReal: 2 };
  const socket = fakeAgent(() => answer);
  const env = { CLAUDE_CONFIG_DIR: home, CCX_API_SOCKET: socket };

  const shown = await run(["session", "status", SID], env);
  expect(shown.code).toBe(0);
  expect(shown.out).toMatch(/^keepalive\s+short_ttl, 5m cache, 2 beats since the last prompt$/m);

  const json = JSON.parse((await run(["session", "status", SID, "--json"], env)).out);
  expect(json.sessionId).toBe(SID);
  // Fields at their zero value are spelled out, as `ccx-agent status` does.
  expect(json.agent.heartbeat).toMatchObject({ registered: true, idleReason: "short_ttl", cacheTtl: "5m", beatsSinceReal: 2, sent: 0 });
  // collect is the machine's spool, not this session's.
  expect(Object.keys(json.agent)).toEqual(["heartbeat"]);

  const down = { CLAUDE_CONFIG_DIR: home, CCX_API_SOCKET: join(home, "none.sock") };
  const off = await run(["session", "status", SID], down);
  expect(off.code).toBe(0);
  expect(off.out).toMatch(/^keepalive\s+unknown \(ccx-agent is not answering\)$/m);
  expect(JSON.parse((await run(["session", "status", SID, "--json"], down)).out).agent).toBeNull();

  // A session neither running here nor registered with the agent has no keepalive to speak of;
  // --json still carries what the agent said.
  rmSync(join(home, "sessions", `${process.pid}.json`));
  answer = { registered: false };
  const ended = await run(["session", "status", SID], env);
  expect(ended.out).toMatch(/^lifecycle\s+ended$/m);
  expect(ended.out).toMatch(/^keepalive\s+-$/m);
  expect(JSON.parse((await run(["session", "status", SID, "--json"], env)).out).agent.heartbeat).toMatchObject({ registered: false });
  // Not running and no agent: still "-", not "unknown".
  expect((await run(["session", "status", SID], down)).out).toMatch(/^keepalive\s+-$/m);

  // One the agent still holds is shown even though this home has no live pid for it
  // (the old id after /clear, a session under another CLAUDE_CONFIG_DIR).
  answer = { idleReason: "beat_pending", cacheTtl: "1h" };
  const held = await run(["session", "status", SID], env);
  expect(held.out).toMatch(/^lifecycle\s+ended$/m);
  expect(held.out).toMatch(/^keepalive\s+beat_pending, 1h cache$/m);
});

test("ccx agent status counts the running sessions' keepalive states on one line and lists them in --json", async () => {
  const home = homeWithRunningSessions(SID, SID2);
  const socket = fakeAgent((req) => (req.sessionId === SID ? { idleReason: "short_ttl", cacheTtl: "5m" } : { nextAt: ago(-20), cacheTtl: "1h" }));
  const hook = join(tmp("ccx-keepalive-hook-"), "ccx-agent.sock");
  const server = createServer().listen(hook);
  cleanups.push(() => server.close());
  const env = { CLAUDE_CONFIG_DIR: home, CCX_API_SOCKET: socket, CCX_SOCKET: hook, CCX_SPOOL: join(home, "spool") };

  const shown = await run(["agent", "status"], env);
  expect(shown.code).toBe(0);
  expect(shown.out).toMatch(/^ccx-agent\s+running$/m);
  expect(shown.out).toMatch(/^keepalive\s+1 scheduled, 1 short_ttl$/m);

  const json = JSON.parse((await run(["agent", "status", "--json"], env)).out);
  expect(json.socketConnectable).toBe(true);
  // Each session carries its own answer, in id order.
  expect(json.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([SID, SID2]);
  expect(json.sessions[0].heartbeat).toMatchObject({ registered: true, idleReason: "short_ttl", cacheTtl: "5m", sent: 0 });
  expect(json.sessions[1].heartbeat).toMatchObject({ registered: true, idleReason: "", cacheTtl: "1h" });
  expect(json.sessions[1].heartbeat.nextAt).toBeString();

  // The API socket not answering: the session is still listed, its heartbeat unknown.
  const down = { ...env, CCX_API_SOCKET: join(home, "none.sock") };
  expect((await run(["agent", "status"], down)).out).toMatch(/^keepalive\s+2 unknown$/m);
  expect(JSON.parse((await run(["agent", "status", "--json"], down)).out).sessions).toEqual([
    { sessionId: SID, heartbeat: null },
    { sessionId: SID2, heartbeat: null },
  ]);
});
