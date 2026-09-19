/**
 * push / pull / prune を、本物の保存先 (ccx-center の object API) に対して HTTP 越しに回す。
 * 2 つの偽 CLAUDE_CONFIG_DIR を「マシン A」「マシン B」に見立てる。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "@ccx/hub/src/db/open.ts";
import { ObjectStore } from "@ccx/hub/src/objects.ts";
import { createApp } from "@ccx/hub/src/server.ts";

import { encodeCwd } from "./scan.ts";
import {
  localTranscripts,
  runningSessionIds,
  sha256,
  transcriptFacts,
  TranscriptClient,
  type LocalTranscript,
} from "./transcript.ts";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const CWD_A = "/home/a/.ccx/github.com/o/r/01AAAAAAAAAAAA";

let server: ReturnType<typeof Bun.serve>;
let db: ReturnType<typeof openDb>;
let root: string;
let homeA: string;
let homeB: string;
let A: TranscriptClient;
let B: TranscriptClient;

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const transcriptBody = [
  line({ type: "user", cwd: CWD_A, gitBranch: "feat/x", version: "2.1.300", message: "PORTABILITY-TEST-1" }),
  line({ type: "assistant", cwd: CWD_A, message: { model: "claude-opus-5" } }),
].join("");

async function seedA(): Promise<LocalTranscript> {
  const projectDir = join(homeA, "projects", encodeCwd(CWD_A));
  await mkdir(join(projectDir, SID, "tool-results"), { recursive: true });
  await Bun.write(join(projectDir, `${SID}.jsonl`), transcriptBody);
  await Bun.write(join(projectDir, SID, "tool-results", "abc.txt"), "big tool output");
  // uuid でない名前は transcript ではない
  await Bun.write(join(projectDir, "notes.jsonl"), "x\n");
  const [t] = await localTranscripts(homeA);
  return t!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-tstore-"));
  homeA = await mkdtemp(join(tmpdir(), "ccx-homeA-"));
  homeB = await mkdtemp(join(tmpdir(), "ccx-homeB-"));
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

describe("transcript: local side", () => {
  test("localTranscripts finds <uuid>.jsonl under any project dir, with its tool-results", async () => {
    const t = await seedA();
    expect((await localTranscripts(homeA)).map((x) => x.sessionId)).toEqual([SID]);
    expect(t.toolResultsDir).toBe(join(homeA, "projects", encodeCwd(CWD_A), SID, "tool-results"));
    expect(await localTranscripts(join(homeA, "nope"))).toEqual([]);
  });

  test("transcriptFacts takes cwd / gitBranch / version from the first records that carry them", async () => {
    const t = await seedA();
    expect(await transcriptFacts(t.path)).toEqual({ cwd: CWD_A, gitBranch: "feat/x", version: "2.1.300" });
  });

  test("runningSessionIds counts only pids that are alive", async () => {
    const dir = join(homeA, "sessions");
    await mkdir(dir, { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await Bun.write(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "live" }));
    await Bun.write(join(dir, `${dead.pid}.json`), JSON.stringify({ pid: dead.pid, sessionId: "dead" }));
    await Bun.write(join(dir, "garbage.json"), "{");
    expect([...(await runningSessionIds(homeA))]).toEqual(["live"]);
  });
});

describe("transcript: push / pull / prune through the store", () => {
  test("push puts the file byte for byte, tool-results, session.json and a history entry; a second push is unchanged", async () => {
    const t = await seedA();
    const r1 = await A.push(t);
    expect(r1.status).toBe("pushed");
    expect(r1.meta).toMatchObject({ sessionId: SID, machine: "host-a", user: "alice", cwd: CWD_A, gitBranch: "feat/x", toolResults: ["abc.txt"] });

    const prefix = `p/transcripts/machine=host-a/user=alice/session_id=${SID}/`;
    expect(await A.s3.file(`${prefix}transcript.jsonl`).text()).toBe(transcriptBody);
    expect(await A.s3.file(`${prefix}tool-results/abc.txt`).text()).toBe("big tool output");
    expect(await Bun.file(join(root, "ccx", `${prefix}session.json`)).exists()).toBe(true);
    expect((await A.history(r1.meta)).map((e) => [e.op, e.machine])).toEqual([["push", "host-a"]]);

    expect((await A.push(t)).status).toBe("unchanged");
    expect((await A.history(r1.meta)).length).toBe(1);

    // 内容が変わればもう一度置く
    await Bun.write(t.path, `${transcriptBody}${line({ type: "user", message: "more" })}`);
    expect((await A.push({ ...t, size: transcriptBody.length + 40 })).status).toBe("pushed");
    expect((await A.history(r1.meta)).length).toBe(2);
  });

  test("pull on another machine lands where claude --resume finds it, records who pulled, and refuses to clobber", async () => {
    const t = await seedA();
    await A.push(t);

    const r = await B.pull(SID, homeB);
    expect(r.status).toBe("pulled");
    expect(r.path).toBe(join(homeB, "projects", encodeCwd(CWD_A), `${SID}.jsonl`));
    expect(await sha256(r.path)).toBe(await sha256(t.path));
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "tool-results", "abc.txt")).text()).toBe("big tool output");

    const h = await B.history(r.meta);
    expect(h.map((e) => [e.op, e.machine, e.user])).toEqual([
      ["push", "host-a", "alice"],
      ["pull", "host-b", "bob"],
    ]);

    expect((await B.pull(SID, homeB)).status).toBe("already-here");

    await Bun.write(r.path, "something else\n");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/different content/);
    expect(await Bun.file(r.path).text()).toBe("something else\n");
    expect((await B.pull(SID, homeB, true)).status).toBe("pulled");
    expect(await Bun.file(r.path).text()).toBe(transcriptBody);

    await expect(B.pull("00000000-0000-4000-8000-000000000000", homeB)).rejects.toThrow(/not in the store/);
  });

  test("pull refuses to install a download that does not match session.json", async () => {
    const t = await seedA();
    await A.push(t);
    const stored = join(root, "ccx", `p/transcripts/machine=host-a/user=alice/session_id=${SID}/transcript.jsonl`);
    await Bun.write(stored, (await Bun.file(stored).text()).replace("PORTABILITY-TEST-1", "PORTABILITY-TEST-X"));

    await expect(B.pull(SID, homeB)).rejects.toThrow(/does not match/);
    const path = join(homeB, "projects", encodeCwd(CWD_A), `${SID}.jsonl`);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(`${path}.pull-tmp`).exists()).toBe(false);
  });

  test("list and find see sessions from every machine", async () => {
    const t = await seedA();
    await A.push(t);
    await B.push({ ...t, sessionId: SID }); // 同じ id を別マシンからも
    const metas = await A.list();
    expect(metas.map((m) => m.machine).sort()).toEqual(["host-a", "host-b"]);
    expect((await B.find(SID))?.sessionId).toBe(SID);
    expect(await B.find("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("prune deletes only when the store's copy reads back identical, and never a running session", async () => {
    const t = await seedA();

    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("push first") });

    await A.push(t);
    expect(await A.prune(t, new Set([SID]))).toMatchObject({ status: "refused", reason: "session is running" });
    expect(await Bun.file(t.path).exists()).toBe(true);

    // 保存先の写しを (同じ長さのまま) 壊す → 読み戻しで違いが出て消さない
    const stored = join(root, "ccx", `p/transcripts/machine=host-a/user=alice/session_id=${SID}/transcript.jsonl`);
    const good = await Bun.file(stored).text();
    await Bun.write(stored, good.replace("PORTABILITY-TEST-1", "PORTABILITY-TEST-X"));
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("differs") });
    expect(await Bun.file(t.path).exists()).toBe(true);
    await Bun.write(stored, good);

    // ローカルが push 後に進んでいても消さない
    const grown = `${transcriptBody}${line({ type: "user", message: "after push" })}`;
    await Bun.write(t.path, grown);
    expect(await A.prune({ ...t, size: grown.length }, new Set())).toMatchObject({ status: "refused" });
    await Bun.write(t.path, transcriptBody);

    const r = await A.prune(t, new Set());
    expect(r.status).toBe("pruned");
    expect(await Bun.file(t.path).exists()).toBe(false);
    expect(await Bun.file(join(t.projectDir, SID, "tool-results", "abc.txt")).exists()).toBe(false);
    expect((await A.history(r.meta!)).map((e) => e.op)).toEqual(["push", "prune"]);

    // 消した後も保存先から戻せる
    expect((await A.pull(SID, homeA)).status).toBe("pulled");
    expect(await Bun.file(t.path).text()).toBe(transcriptBody);
  });
});
