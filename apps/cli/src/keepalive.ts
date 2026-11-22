/**
 * What ccx-agent says a session's heartbeat keepalive is doing (#274), for
 * `ccx session status` and `ccx agent status`. The agent is asked over its
 * unix socket; when it does not answer the CLI still works and the state
 * reads "unknown" — a missing or silent ccx-agent is not an error for either
 * command.
 */
import { toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
import { resolve } from "node:path";

import { AgentService, HeartbeatStatusSchema, type GetSessionStatusResponse, type HeartbeatStatus } from "@ccx/proto/ccx/v1/agent_pb.ts";

import { humanSince } from "./format.ts";
import { unixTransport } from "./msg.ts";

/**
 * One session's status from ccx-agent, or undefined on any failure: no
 * socket, a refused or timed-out call, an error answer. Every failure reads
 * the same because the caller only needs "no answer", not why.
 */
export async function sessionAgentStatus(
  socket: string,
  sessionId: string,
  claudeHome: string,
): Promise<GetSessionStatusResponse | undefined> {
  try {
    const client = createClient(AgentService, unixTransport(socket));
    // The agent reads a relative home as its own default, so a relative CLAUDE_CONFIG_DIR goes absolute here.
    // 2 s: the answer is a few file reads on this machine; an agent that accepts and never answers must not hang a status.
    return await client.getSessionStatus({ sessionId, claudeHome: resolve(claudeHome) }, { signal: AbortSignal.timeout(2000) });
  } catch {
    return undefined;
  }
}

/**
 * The first thing that stops a beat, in the order a reader asks: is the agent
 * there, is heartbeat on in its config, is its channel socket open, is this
 * session registered on a channel, is something scheduled — else the agent's
 * own reason nothing is.
 */
export function keepaliveState(h: HeartbeatStatus | undefined): string {
  if (h === undefined) return "unknown";
  if (!h.enabled) return "off";
  if (!h.listening) return "not listening";
  if (!h.registered) return h.wanted ? "not registered" : "not_wanted";
  if (h.nextAt) return "scheduled";
  return h.idleReason || "not scheduled";
}

// States whose bare word would mislead get the reason spelled out; the rest
// (the agent's idle reasons, "not_wanted", "not scheduled") read as they are.
const HEAD: Record<string, string> = {
  unknown: "unknown (ccx-agent is not answering)",
  off: "off (heartbeat is off in ccx-agent's config)",
  "not listening": "not listening (ccx-agent could not open its channel socket)",
  "not registered": "not registered (no channel to push a heartbeat through)",
};

/**
 * One session's keepalive as a single line: the state, then the cache TTL,
 * the last beat and the beats since the last prompt when there are any.
 * `humanSince` takes (earlier, later); swapping them turns "how long ago"
 * into "how long until", which is what "next in" needs.
 */
export function keepaliveLine(h: HeartbeatStatus | undefined, now = Date.now()): string {
  const state = keepaliveState(h);
  const next = h?.nextAt;
  const parts = [state === "scheduled" && next ? `next in ${humanSince(now, timestampMs(next))}` : (HEAD[state] ?? state)];
  if (h) {
    if (h.cacheTtl) parts.push(`${h.cacheTtl} cache`);
    if (h.lastBeatAt) parts.push(`last beat ${humanSince(timestampMs(h.lastBeatAt), now)} ago`);
    if (h.beatsSinceReal > 0) parts.push(`${h.beatsSinceReal} beat${h.beatsSinceReal === 1 ? "" : "s"} since the last prompt`);
  }
  return parts.join(", ");
}

/** Running sessions counted by keepalive state: scheduled first, the rest by name. */
export function keepaliveSummary(hs: (HeartbeatStatus | undefined)[]): string {
  if (hs.length === 0) return "no running sessions";
  const counts = new Map<string, number>();
  for (const h of hs) {
    const s = keepaliveState(h);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const states = [...counts.keys()].sort((a, b) => {
    if (a === "scheduled") return -1;
    if (b === "scheduled") return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return states.map((s) => `${counts.get(s)} ${s}`).join(", ");
}

/** The heartbeat part of the agent's answer as `--json` prints it, fields at their zero value spelled out; null with no answer. */
export function heartbeatJson(res: GetSessionStatusResponse | undefined): JsonValue {
  return res?.heartbeat ? toJson(HeartbeatStatusSchema, res.heartbeat, { alwaysEmitImplicit: true }) : null;
}
