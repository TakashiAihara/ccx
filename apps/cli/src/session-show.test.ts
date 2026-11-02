/**
 * `ccx session show` must not interleave the streams of one session id (#151). A real center runs on
 * loopback; events are ingested straight into its store, as the agents of several users would send them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";
import { openDb } from "@ccx/hub/src/db/open.ts";
import { ObjectStore } from "@ccx/hub/src/objects.ts";
import { createApp } from "@ccx/hub/src/server.ts";
import { ingest } from "@ccx/hub/src/store.ts";

import { AmbiguousSession, showEvents, streamsOf } from "./session-show.ts";

const SID = "0f9a1b2c-2222-4f60-8a7b-9c0d1e2f3a4b";
const cli = join(import.meta.dir, "index.ts");

let server: ReturnType<typeof Bun.serve>;
let db: ReturnType<typeof openDb>;
let root: string;
let home: string;
/** Every ListEvents request the center received, in order */
let requests: number;

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
let n = 0;
/** A declared-state report (`ccx session mark`, or the state `ccx tr pull` installs), as session-state.ts sends it */
const mark = (machine: string, user: string) => {
  n += 1;
  return {
    eventId: `s-${n}`,
    machine,
    user,
    seq: n,
    receivedAtMs: 1_700_000_000_000 + n * 1000,
    producer: 2,
    payload: enc({ session_id: SID, rev: n, marks: ["archived"], label: "", task: "", role: "", metadata: {} }),
  };
};
const hook = (machine: string, user: string, name: string, sid = SID) => {
  n += 1;
  return {
    eventId: `e-${n}`,
    machine,
    user,
    seq: n,
    receivedAtMs: 1_700_000_000_000 + n * 1000,
    producer: 1,
    payload: enc({ session_id: sid, hook_event_name: name, cwd: "/w" }),
  };
};

const client = () => createClient(FleetService, createConnectTransport({ baseUrl: `http://127.0.0.1:${server.port}` }));

beforeEach(async () => {
  n = 0;
  requests = 0;
  root = await mkdtemp(join(tmpdir(), "ccx-show-store-"));
  home = await mkdtemp(join(tmpdir(), "ccx-show-home-"));
  db = openDb(":memory:");
  const app = createApp(db, new ObjectStore(root));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/ListEvents")) requests += 1;
      return app.fetch(req);
    },
  });
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await Promise.all([root, home].map((d) => rm(d, { recursive: true, force: true })));
});

describe("streamsOf", () => {
  test("keeps one entry per (machine, user), sorted by machine then user", () => {
    const got = streamsOf([
      { machine: "m2", user: "a" },
      { machine: "m1", user: "b" },
      { machine: "m1", user: "a" },
      { machine: "m1", user: "b" },
    ]);
    expect(got).toEqual([
      { machine: "m1", user: "a" },
      { machine: "m1", user: "b" },
      { machine: "m2", user: "a" },
    ]);
  });
});

describe("showEvents", () => {
  test("two users on one machine sharing the id: refuses and names both streams", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart"), hook("m1", "ccxu1", "Stop"), hook("m1", "ccxu2", "Stop")]);

    const err = await showEvents(client(), { sessionId: SID, includePayload: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSession);
    expect((err as AmbiguousSession).streams).toEqual([
      { machine: "m1", user: "ccxu1" },
      { machine: "m1", user: "ccxu2" },
    ]);
    expect((err as Error).message).toContain(`session ${SID} exists in 2 streams`);
    expect((err as Error).message).toContain("-m m1 -u ccxu2");
  });

  test("two machines with the same user: -u alone does not settle it", async () => {
    ingest(db, [hook("m1", "alice", "SessionStart"), hook("m2", "alice", "SessionStart")]);

    const err = await showEvents(client(), { sessionId: SID, user: "alice", includePayload: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSession);
    expect((err as AmbiguousSession).streams).toEqual([
      { machine: "m1", user: "alice" },
      { machine: "m2", user: "alice" },
    ]);
  });

  test("two users on one machine: -m alone does not settle it", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart"), hook("m2", "ccxu1", "Stop")]);

    const err = await showEvents(client(), { sessionId: SID, machine: "m1", includePayload: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSession);
    expect((err as AmbiguousSession).streams).toEqual([
      { machine: "m1", user: "ccxu1" },
      { machine: "m1", user: "ccxu2" },
    ]);
  });

  test("-u that leaves one stream returns only that stream's events", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart"), hook("m1", "ccxu1", "Stop"), hook("m1", "ccxu2", "PostToolUse")]);

    const got = await showEvents(client(), { sessionId: SID, user: "ccxu2", includePayload: false });
    expect(got.map((e) => `${e.user}:${e.hookEventName}`)).toEqual(["ccxu2:PostToolUse", "ccxu2:SessionStart"]);
  });

  test("-m that leaves one stream returns only that stream's events", async () => {
    ingest(db, [hook("m1", "alice", "SessionStart"), hook("m2", "alice", "Stop")]);

    const got = await showEvents(client(), { sessionId: SID, machine: "m2", includePayload: false });
    expect(got.map((e) => `${e.machine}:${e.hookEventName}`)).toEqual(["m2:Stop"]);
  });

  test("a hook filter that only one stream matches still refuses: the other stream exists", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "Stop")]);

    const err = await showEvents(client(), { sessionId: SID, hookEventName: "SessionStart", includePayload: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSession);
  });

  test("a page holding two streams refuses even when the probe sees only one", async () => {
    // The probe is the second ListEvents; answer it with nothing so only the page can tell
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart")]);
    const app = createApp(db, new ObjectStore(root));
    void server.stop(true);
    let calls = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/ListEvents")) return app.fetch(req);
        calls += 1;
        if (calls === 1) return app.fetch(req);
        return Response.json({ events: [] });
      },
    });

    const err = await showEvents(client(), { sessionId: SID, includePayload: false }).catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(AmbiguousSession);
  });

  test("one stream: returns its events, newest first", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu1", "Stop"), hook("m1", "ccxu2", "Stop", "1f9a1b2c-2222-4f60-8a7b-9c0d1e2f3a4b")]);

    const got = await showEvents(client(), { sessionId: SID, includePayload: false });
    expect(got.map((e) => e.hookEventName)).toEqual(["Stop", "SessionStart"]);
  });

  test("-m and -u together name the stream fully, so no probe is sent", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart")]);

    const got = await showEvents(client(), { sessionId: SID, machine: "m1", user: "ccxu1", includePayload: false });
    expect(got.map((e) => e.user)).toEqual(["ccxu1"]);
    expect(requests).toBe(1);
  });

  test("the hook filter and the limit reach the center", async () => {
    ingest(db, [
      hook("m1", "ccxu1", "SessionStart"),
      hook("m1", "ccxu1", "PostToolUse"),
      hook("m1", "ccxu1", "PostToolUse"),
      hook("m1", "ccxu1", "PostToolUse"),
      hook("m1", "ccxu1", "Stop"),
    ]);

    const got = await showEvents(client(), { sessionId: SID, hookEventName: "PostToolUse", limit: 2, includePayload: false });
    expect(got.map((e) => `${e.seq}:${e.hookEventName}`)).toEqual(["4:PostToolUse", "3:PostToolUse"]);
  });

  test("a stream holding only marks (a session moved by `ccx tr pull`) is not a second stream", async () => {
    ingest(db, [hook("m1", "alice", "SessionStart"), hook("m1", "alice", "Stop"), mark("m2", "alice")]);

    const got = await showEvents(client(), { sessionId: SID, includePayload: false });
    expect(got.map((e) => `${e.machine}:${e.producer}`)).toEqual(["m2:2", "m1:1", "m1:1"]);
  });

  test("marks in the same stream as the hooks change nothing", async () => {
    ingest(db, [hook("m1", "alice", "SessionStart"), mark("m1", "alice")]);

    const got = await showEvents(client(), { sessionId: SID, includePayload: false });
    expect(got).toHaveLength(2);
  });

  test("a second stream older than the page but inside the probe window still refuses", async () => {
    // 150 newer events of ccxu1 push ccxu2 beyond the center's default page of 100, so only a
    // probe that asks for its full window sees it
    ingest(db, [hook("m1", "ccxu2", "SessionStart"), ...Array.from({ length: 150 }, () => hook("m1", "ccxu1", "PostToolUse"))]);

    const err = await showEvents(client(), { sessionId: SID, limit: 1, includePayload: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSession);
  });

  test("allowMixed returns every stream's events without refusing", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart"), hook("m1", "ccxu1", "Stop")]);

    const got = await showEvents(client(), { sessionId: SID, includePayload: false, allowMixed: true });
    expect(got.map((e) => e.user)).toEqual(["ccxu1", "ccxu2", "ccxu1"]);
    expect(requests).toBe(1);
  });
});

describe("ccx session show", () => {
  async function run(args: string[]) {
    const p = Bun.spawn(["bun", "run", cli, "session", "show", ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, CCX_HUB_URL: `http://127.0.0.1:${server.port}`, CCX_HUB_TOKEN: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  }

  test("text output with the id in two streams exits 1, prints nothing, and lists the -m / -u to pick", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "SessionStart")]);

    const r = await run([SID]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).not.toContain("did not answer");
    expect(r.err).toContain(`session ${SID} exists in 2 streams`);
    expect(r.err).toContain("-m m1 -u ccxu1");
    expect(r.err).toContain("-m m1 -u ccxu2");
  });

  test("-u picks one stream and prints its events", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "Stop")]);

    const r = await run([SID, "-u", "ccxu2"]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([expect.stringMatching(/Z {2}Stop$/)]);
  });

  test("--json keeps returning every stream, each event labelled", async () => {
    ingest(db, [hook("m1", "ccxu1", "SessionStart"), hook("m1", "ccxu2", "Stop")]);

    const r = await run([SID, "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { user: string }[]).map((e) => e.user)).toEqual(["ccxu2", "ccxu1"]);
  });
});
