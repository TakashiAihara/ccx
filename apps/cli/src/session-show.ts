import type { Client } from "@connectrpc/connect";

import type { EventRecord, FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";
import { Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

/** One (machine, user) stream. The center keys a session by (machine, user, session_id), not by the id alone */
export type Stream = { machine: string; user: string };

/**
 * The largest page the center serves (fleet.proto). The probe reads this many of the newest
 * events for the id to find the other streams that share it.
 */
const PROBE_LIMIT = 1000;

export type ShowRequest = {
  sessionId: string;
  machine?: string;
  user?: string;
  hookEventName?: string;
  limit?: number;
  includePayload: boolean;
  /** --json labels every event with its machine and user, so mixing streams there misleads no one */
  allowMixed?: boolean;
};

/**
 * The same session id seen from several (machine, user) streams. Without -m / -u the text output
 * would interleave their events with nothing to tell them apart (#151), so stop and name them.
 */
export class AmbiguousSession extends Error {
  constructor(
    readonly sessionId: string,
    readonly streams: Stream[],
  ) {
    super(
      [
        `session ${sessionId} exists in ${streams.length} streams; pick one with -m / -u:`,
        ...streams.map((s) => `  -m ${s.machine} -u ${s.user}`),
      ].join("\n"),
    );
    this.name = "AmbiguousSession";
  }
}

/**
 * Streams that `ccx session ls` lists as rows: those with at least one hook event. A stream holding
 * only declared-state events (a mark, or the state `ccx tr pull` installed on the machine a session
 * moved to) is an attribute of the session, not a second stream, and refusing on it would break
 * `session show` right after every move.
 */
export function hookStreams(events: readonly (Stream & { producer: Producer })[]): Stream[] {
  return streamsOf(events.filter((e) => e.producer === Producer.CLAUDE_CODE_HOOK));
}

/** Distinct (machine, user) pairs, sorted so the candidate list reads the same on every run */
export function streamsOf(events: readonly Stream[]): Stream[] {
  const seen = new Map<string, Stream>();
  for (const e of events) seen.set(`${e.machine}\0${e.user}`, { machine: e.machine, user: e.user });
  return [...seen.values()].sort((a, b) => a.machine.localeCompare(b.machine) || a.user.localeCompare(b.user));
}

/**
 * Events of one session for `ccx session show`, refusing to mix streams.
 *
 * The check looks at two sets: the page that will be printed, and a probe of the newest
 * PROBE_LIMIT events for the id under the same -m / -u (no hook filter, no payload). The page
 * alone is enough to guarantee the output never interleaves the hooks of two streams; the probe
 * also catches a second stream the page happens not to show (a -e filter that only one stream
 * matches, or a -n smaller than the newer stream's run of events). A stream whose events are all
 * older than the probe window is not detected; the hooks printed are then still a single stream.
 * Declared-state events of a stream without hooks are printed as before (see hookStreams).
 *
 * With both -m and -u given the stream is fully named and nothing can overlap, so no probe is sent.
 */
export async function showEvents(client: Client<typeof FleetService>, req: ShowRequest): Promise<EventRecord[]> {
  const machine = req.machine ?? "";
  const user = req.user ?? "";

  const res = await client.listEvents({
    sessionId: req.sessionId,
    machine,
    user,
    hookEventName: req.hookEventName ?? "",
    limit: req.limit ?? 0,
    includePayload: req.includePayload,
  });
  if (req.allowMixed || (machine && user)) return res.events;

  const probe = await client.listEvents({ sessionId: req.sessionId, machine, user, limit: PROBE_LIMIT, includePayload: false });
  const streams = hookStreams([...res.events, ...probe.events]);
  if (streams.length > 1) throw new AmbiguousSession(req.sessionId, streams);

  return res.events;
}
