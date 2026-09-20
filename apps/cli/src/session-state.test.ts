/**
 * 宣言された状態が保存先と往復すること (#127)。transcript.test.ts と同じく本物の
 * center の object API を loopback で立て、2 つの CLAUDE_CONFIG_DIR を 2 台に見立てる
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "@ccx/hub/src/db/open.ts";
import { ObjectStore } from "@ccx/hub/src/objects.ts";
import { createApp } from "@ccx/hub/src/server.ts";

import { encodeCwd, EMPTY_DECLARED, localTranscripts, readDeclared, TranscriptClient, writeDeclared, type LocalTranscript } from "@ccx/core";

import { lifecycleOf } from "./session-state.ts";
import { select } from "./transcript.ts";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const SID2 = "1f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const CWD = "/home/a/.ccx/github.com/o/r/01AAAAAAAAAAAA";

let server: ReturnType<typeof Bun.serve>;
let db: ReturnType<typeof openDb>;
let root: string;
let homeA: string;
let homeB: string;
let A: TranscriptClient;
let B: TranscriptClient;

const body = (msg: string) => `${JSON.stringify({ type: "user", cwd: CWD, gitBranch: "main", version: "2.1.300", message: msg })}\n`;

async function seed(home: string, id: string, msg = "hello"): Promise<LocalTranscript> {
  const projectDir = join(home, "projects", encodeCwd(CWD));
  await mkdir(projectDir, { recursive: true });
  await Bun.write(join(projectDir, `${id}.jsonl`), body(msg));
  return (await localTranscripts(home)).find((t) => t.sessionId === id)!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-sstore-"));
  homeA = await mkdtemp(join(tmpdir(), "ccx-shomeA-"));
  homeB = await mkdtemp(join(tmpdir(), "ccx-shomeB-"));
  db = openDb(":memory:");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(root)).fetch });
  const store = { endpoint: `http://127.0.0.1:${server.port}`, bucket: "ccx", prefix: "p/" };
  A = new TranscriptClient(store, { machine: "host-a", user: "alice" });
  B = new TranscriptClient(store, { machine: "host-b", user: "bob" });
});

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await Promise.all([root, homeA, homeB].map((d) => rm(d, { recursive: true, force: true })));
});

describe("session state travels with the transcript", () => {
  const stateKey = () => join(root, "ccx", `p/transcripts/machine=host-a/user=alice/session_id=${SID}/state.json`);

  test("push writes state.json from the local marks; a mark changed after push goes up as `state` without re-sending the transcript", async () => {
    const t = await seed(homeA, SID);
    await writeDeclared(SID, { done: true, label: "L", task: "kaneo ccx#1" }, homeA);

    const r1 = await A.push(t, homeA);
    expect(r1.status).toBe("pushed");
    expect(r1.state).toEqual({ ...EMPTY_DECLARED, done: true, label: "L", task: "kaneo ccx#1" });
    expect(await Bun.file(stateKey()).json()).toEqual(r1.state);
    expect(await A.readRemoteDeclared(SID)).toEqual(r1.state);

    expect((await A.push(t, homeA)).status).toBe("unchanged");

    await writeDeclared(SID, { pinned: true }, homeA);
    const r2 = await A.push(t, homeA);
    expect(r2.status).toBe("state");
    expect((await Bun.file(stateKey()).json()).pinned).toBe(true);
    // transcript は置き直していない (history は最初の push の 1 件のまま)
    expect((await A.history(r2.meta)).map((e) => e.op)).toEqual(["push"]);

    // 印を外しても運ぶ (「無い」ではなく「false」を置く)
    await writeDeclared(SID, { done: false, pinned: false, label: "", task: "" }, homeA);
    expect((await A.push(t, homeA)).status).toBe("state");
    expect(await A.readRemoteDeclared(SID)).toEqual(EMPTY_DECLARED);
  });

  test("pull installs the store's state as local marks on a fresh machine, but does not touch marks when the transcript is already here", async () => {
    const t = await seed(homeA, SID);
    await writeDeclared(SID, { done: true, ephemeral: true, label: "L" }, homeA);
    await A.push(t, homeA);

    const r = await B.pull(SID, homeB);
    expect(r.status).toBe("pulled");
    expect(r.state).toEqual({ ...EMPTY_DECLARED, done: true, ephemeral: true, label: "L" });
    expect(await readDeclared(SID, homeB)).toEqual(r.state);
    // ephemeral は SessionEnd hook が読む名前で置かれる
    expect(await Bun.file(join(homeB, "sessions", SID, "delete")).exists()).toBe(true);

    // B で印を変えてから再度 pull (already-here) しても、B の印は保存先の古い写しで消えない
    await writeDeclared(SID, { done: false, pinned: true }, homeB);
    const again = await B.pull(SID, homeB);
    expect(again.status).toBe("already-here");
    expect(again.state?.done).toBe(true);
    expect(await readDeclared(SID, homeB)).toEqual({ ...EMPTY_DECLARED, ephemeral: true, pinned: true, label: "L" });
  });

  test("a session pushed before state.json existed pulls with state null and leaves local marks alone", async () => {
    const t = await seed(homeA, SID);
    await A.push(t, homeA);
    await rm(stateKey());
    expect(await A.readRemoteDeclared(SID)).toBeNull();
    await writeDeclared(SID, { pinned: true }, homeB);
    const r = await B.pull(SID, homeB);
    expect(r.status).toBe("pulled");
    expect(r.state).toBeNull();
    expect(await readDeclared(SID, homeB)).toEqual({ ...EMPTY_DECLARED, pinned: true });
  });

  test("lifecycle: running by pid, ended by a local transcript, archived by the store, unknown otherwise", async () => {
    const t = await seed(homeA, SID);
    expect(await lifecycleOf(SID, homeA, new Set([SID]), true, A)).toBe("running");
    expect(await lifecycleOf(SID, homeA, new Set(), true, A)).toBe("ended");
    // 手元に無く、保存先にも無い → unknown。保存先が無い → unknown (「無い」とは言わない)
    expect(await lifecycleOf(SID, homeA, new Set(), false, A)).toBe("unknown");
    expect(await lifecycleOf(SID, homeA, new Set(), false, null)).toBe("unknown");
    await A.push(t, homeA);
    expect(await lifecycleOf(SID, homeA, new Set(), false, A)).toBe("archived");
    // 別マシンが push した写しでも archived
    expect(await lifecycleOf(SID, homeB, new Set(), false, B)).toBe("archived");
    expect(await A.inStore(SID)).toBe(true);
    expect(await B.inStore(SID)).toBe(false);
  });
});

describe("select: --ended / --done", () => {
  test("--done picks sessions marked done (running included for push, excluded for prune); --ended --done is the intersection", async () => {
    await seed(homeA, SID, "one");
    await seed(homeA, SID2, "two");
    await writeDeclared(SID, { done: true }, homeA);
    // SID2 を「動いている」に見せる
    await mkdir(join(homeA, "sessions"), { recursive: true });
    await Bun.write(join(homeA, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SID2 }));
    await writeDeclared(SID2, { done: true }, homeA);

    const ids = (r: { picked: LocalTranscript[] }) => r.picked.map((t) => t.sessionId).sort();
    expect(ids(await select([], { done: true }, { home: homeA }))).toEqual([SID, SID2]);
    expect(ids(await select([], { done: true }, { home: homeA, excludeRunning: true }))).toEqual([SID]);
    expect(ids(await select([], { ended: true }, { home: homeA }))).toEqual([SID]);
    expect(ids(await select([], { ended: true, done: true }, { home: homeA }))).toEqual([SID]);

    await writeDeclared(SID, { done: false }, homeA);
    expect(ids(await select([], { done: true }, { home: homeA }))).toEqual([SID2]);
    expect(ids(await select([], { ended: true, done: true }, { home: homeA }))).toEqual([]);

    // 明示の id は選択子を要らない。何も無ければ止まる
    expect(ids(await select([SID.slice(0, 8)], {}, { home: homeA }))).toEqual([SID]);
    await expect(select([], {}, { home: homeA })).rejects.toThrow(/--ended .* --done/);
  });
});
