/**
 * push / pull / prune を、本物の保存先 (ccx-center の object API) に対して HTTP 越しに回す。
 * 2 つの偽 CLAUDE_CONFIG_DIR を「マシン A」「マシン B」に見立てる。
 *
 * core ではなく cli に置くのは、core (library) が hub (app) に依存する向きを作らないため。
 * 両方を繋ぐのは cli の役目
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openDb } from "@ccx/hub/src/db/open.ts";
import { ObjectStore } from "@ccx/hub/src/objects.ts";
import { createApp } from "@ccx/hub/src/server.ts";

import {
  AmbiguousSessionId,
  encodeCwd,
  localTranscripts,
  runningSessionIds,
  sha256,
  transcriptFacts,
  TranscriptClient,
  type LocalTranscript,
} from "@ccx/core";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const CWD_A = "/home/a/.ccx/github.com/o/r/01AAAAAAAAAAAA";
const SUB = "agent-a1.jsonl";
const WF = "workflows/wf_1/agent-b2.jsonl";
// <session>/workflows/ (subagents/ の外) は run の記録と script
const RUN = "wf_1.json";
const SCRIPT = "scripts/review-wf_1.js";

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
  // 2 行目は別の値。先頭のレコードを採ることを pin するため (同じ値だと最後を採る実装でも通る)
  line({ type: "assistant", cwd: "/elsewhere", gitBranch: "other", version: "9.9.9", message: { model: "claude-opus-5" } }),
].join("");

async function seedA(): Promise<LocalTranscript> {
  const projectDir = join(homeA, "projects", encodeCwd(CWD_A));
  await mkdir(join(projectDir, SID, "tool-results"), { recursive: true });
  await Bun.write(join(projectDir, `${SID}.jsonl`), transcriptBody);
  await Bun.write(join(projectDir, SID, "tool-results", "abc.txt"), "big tool output");
  // subagents は入れ子を持つ (workflows/wf_*/)
  await Bun.write(join(projectDir, SID, "subagents", SUB), "subagent line\n");
  await Bun.write(join(projectDir, SID, "subagents", WF), "workflow agent line\n");
  await Bun.write(join(projectDir, SID, "workflows", RUN), '{"runId":"wf_1"}');
  await Bun.write(join(projectDir, SID, "workflows", SCRIPT), "export const meta = {}\n");
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
    expect(t.subagentsDir).toBe(join(homeA, "projects", encodeCwd(CWD_A), SID, "subagents"));
    expect(t.workflowsDir).toBe(join(homeA, "projects", encodeCwd(CWD_A), SID, "workflows"));
    expect(await localTranscripts(join(homeA, "nope"))).toEqual([]);
  });

  test("transcriptFacts takes cwd / gitBranch / version from the first records that carry them, and stops at the line cap", async () => {
    const t = await seedA();
    expect(await transcriptFacts(t.path)).toEqual({ cwd: CWD_A, gitBranch: "feat/x", version: "2.1.300" });

    // git の外の session: gitBranch はどこにも無い。全行読まずに上限で止まる
    const noGit = join(homeA, "nogit.jsonl");
    await Bun.write(noGit, `${line({ cwd: "/x", version: "1" })}${line({ cwd: "/x" }).repeat(50)}${line({ gitBranch: "late" })}`);
    expect(await transcriptFacts(noGit, 10)).toEqual({ cwd: "/x", gitBranch: "", version: "1" });
    expect(await transcriptFacts(noGit)).toEqual({ cwd: "/x", gitBranch: "late", version: "1" });
  });

  test("runningSessionIds counts only pids that are alive and still the same process", async () => {
    const dir = join(homeA, "sessions");
    await mkdir(dir, { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const procStart = await Bun.file(`/proc/${process.pid}/stat`)
      .text()
      .then((s) => s.slice(s.lastIndexOf(")") + 2).split(" ")[19])
      .catch(() => undefined);
    await Bun.write(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "live", procStart }));
    await Bun.write(join(dir, `${dead.pid}.json`), JSON.stringify({ pid: dead.pid, sessionId: "dead" }));
    // pid は生きているが起動時刻が違う = 番号が巡回して別のプロセス
    if (procStart) {
      await Bun.write(join(dir, `${process.pid + 0}.json.reused`), ""); // 名前が合わないので無視される (対照)
      await Bun.write(join(dir, `1.json`), JSON.stringify({ pid: process.pid, sessionId: "reused", procStart: "1" }));
    }
    await Bun.write(join(dir, "garbage.json"), "{");
    expect([...(await runningSessionIds(homeA))]).toEqual(["live"]);
  });
});

describe("transcript: push / pull / prune through the store", () => {
  const prefixA = `p/transcripts/machine=host-a/user=alice/session_id=${SID}/`;
  const storedA = () => join(root, "ccx", `${prefixA}transcript.jsonl`);

  test("push puts the file byte for byte, tool-results with hashes, session.json and a history entry; a second push is unchanged", async () => {
    const t = await seedA();
    const r1 = await A.push(t);
    expect(r1.status).toBe("pushed");
    expect(r1.meta).toMatchObject({ sessionId: SID, machine: "host-a", user: "alice", cwd: CWD_A, gitBranch: "feat/x" });
    expect(r1.meta.toolResults).toEqual([{ name: "abc.txt", sha256: await sha256(join(t.toolResultsDir!, "abc.txt")) }]);

    expect(await A.s3.file(`${prefixA}transcript.jsonl`).text()).toBe(transcriptBody);
    expect(await A.s3.file(`${prefixA}tool-results/abc.txt`).text()).toBe("big tool output");
    expect(r1.meta.subagents).toEqual([
      { name: SUB, sha256: await sha256(join(t.subagentsDir!, SUB)) },
      { name: WF, sha256: await sha256(join(t.subagentsDir!, WF)) },
    ]);
    expect(await A.s3.file(`${prefixA}subagents/${WF}`).text()).toBe("workflow agent line\n");
    expect(r1.meta.workflows).toEqual([
      { name: SCRIPT, sha256: await sha256(join(t.workflowsDir!, SCRIPT)) },
      { name: RUN, sha256: await sha256(join(t.workflowsDir!, RUN)) },
    ]);
    expect(await A.s3.file(`${prefixA}workflows/${SCRIPT}`).text()).toBe("export const meta = {}\n");
    expect(await Bun.file(join(root, "ccx", `${prefixA}session.json`)).exists()).toBe(true);
    expect((await A.history(r1.meta)).map((e) => [e.op, e.machine])).toEqual([["push", "host-a"]]);
    // スナップショットは残らない
    expect(await Bun.file(`${t.path}.push-tmp`).exists()).toBe(false);


    expect((await A.push(t)).status).toBe("unchanged");
    expect((await A.history(r1.meta)).length).toBe(1);

    // transcript が同じでも tool-results が増えれば置き直す
    await Bun.write(join(t.toolResultsDir!, "def.txt"), "another");
    expect((await A.push(t)).status).toBe("pushed");
    expect((await A.find(SID))!.toolResults.map((r) => r.name)).toEqual(["abc.txt", "def.txt"]);

    // subagent が追記しても同じ
    await Bun.write(join(t.subagentsDir!, SUB), "subagent line\nmore\n");
    expect((await A.push(t)).status).toBe("pushed");
    expect(await A.s3.file(`${prefixA}subagents/${SUB}`).text()).toBe("subagent line\nmore\n");
    await Bun.write(join(t.subagentsDir!, SUB), "subagent line\n");
    expect((await A.push(t)).status).toBe("pushed");

    // workflow の run が書き足しても同じ
    await Bun.write(join(t.workflowsDir!, RUN), '{"runId":"wf_1","result":"done"}');
    expect((await A.push(t)).status).toBe("pushed");
    expect(await A.s3.file(`${prefixA}workflows/${RUN}`).text()).toBe('{"runId":"wf_1","result":"done"}');
    await Bun.write(join(t.workflowsDir!, RUN), '{"runId":"wf_1"}');
    expect((await A.push(t)).status).toBe("pushed");

    // 内容が変わればもう一度置く
    await Bun.write(t.path, `${transcriptBody}${line({ type: "user", message: "more" })}`);
    expect((await A.push(t)).status).toBe("pushed");
    expect((await A.history(r1.meta)).map((e) => e.op)).toEqual(["push", "push", "push", "push", "push", "push", "push"]);
  });

  test("push hashes and uploads subagents from one snapshot, so a subagent appending mid-push cannot split session.json from the object", async () => {
    const t = await seedA();
    const write = A.s3.write.bind(A.s3);
    let appended = false;
    // transcript を置いた直後 (subagents を送る前) に、動いている subagent が追記したことにする
    A.s3.write = (async (key: string, data: unknown, opts?: unknown) => {
      const r = await write(key as never, data as never, opts as never);
      if (!appended && key.endsWith("transcript.jsonl")) {
        appended = true;
        await Bun.write(join(t.subagentsDir!, SUB), "subagent line\nappended mid-push\n");
        await Bun.write(join(t.workflowsDir!, RUN), '{"runId":"wf_1","appended":"mid-push"}');
      }
      return r;
    }) as typeof A.s3.write;
    const r = await A.push(t);
    expect(appended).toBe(true);
    const listed = r.meta.subagents!.find((x) => x.name === SUB)!;
    const h = new Bun.CryptoHasher("sha256").update(await A.s3.file(`${prefixA}subagents/${SUB}`).bytes()).digest("hex");
    expect(h).toBe(listed.sha256);
    const run = r.meta.workflows!.find((x) => x.name === RUN)!;
    expect(new Bun.CryptoHasher("sha256").update(await A.s3.file(`${prefixA}workflows/${RUN}`).bytes()).digest("hex")).toBe(run.sha256);
  });

  test("pull on another machine lands where claude --resume finds it, records who pulled, and refuses to clobber", async () => {
    const t = await seedA();
    await Bun.write(join(t.toolResultsDir!, "nested", "abc.txt"), "nested output");
    await A.push(t);

    const r = await B.pull(SID, homeB);
    expect(r.status).toBe("pulled");
    expect(r.path).toBe(join(homeB, "projects", encodeCwd(CWD_A), `${SID}.jsonl`));
    // 入れ子の tool-results も名前のまま戻る (basename に潰さない)
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "tool-results", "nested", "abc.txt")).text()).toBe("nested output");
    expect(await sha256(r.path)).toBe(await sha256(t.path));
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "tool-results", "abc.txt")).text()).toBe("big tool output");
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "subagents", WF)).text()).toBe("workflow agent line\n");
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "workflows", SCRIPT)).text()).toBe("export const meta = {}\n");

    const h = await B.history(r.meta);
    expect(h.map((e) => [e.op, e.machine, e.user])).toEqual([
      ["push", "host-a", "alice"],
      ["pull", "host-b", "bob"],
    ]);

    expect((await B.pull(SID, homeB)).status).toBe("already-here");

    // 手元の subagent が保存先と違えば (push していない続き)、force なしでは上書きしない
    const localSub = join(homeB, "projects", encodeCwd(CWD_A), SID, "subagents", SUB);
    await Bun.write(localSub, "subagent line\nlocal continuation\n");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/exists with different content/);
    expect(await Bun.file(localSub).text()).toBe("subagent line\nlocal continuation\n");
    const forcedSub = await B.pull(SID, homeB, true);
    expect(forcedSub.status).toBe("pulled");
    expect(await Bun.file(localSub).text()).toBe("subagent line\n");
    const kept = (await readdir(dirname(localSub))).filter((n) => n.startsWith(`${SUB}.replaced-`));
    expect(kept.length).toBe(1);
    expect(await Bun.file(join(dirname(localSub), kept[0]!)).text()).toBe("subagent line\nlocal continuation\n");
    await rm(join(dirname(localSub), kept[0]!));

    // subagents が欠けていても埋め直す
    await rm(join(homeB, "projects", encodeCwd(CWD_A), SID, "subagents"), { recursive: true, force: true });
    expect((await B.pull(SID, homeB)).status).toBe("pulled");
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "subagents", SUB)).text()).toBe("subagent line\n");

    // workflows が欠けていても already-here にはならず、埋め直す
    await rm(join(homeB, "projects", encodeCwd(CWD_A), SID, "workflows"), { recursive: true, force: true });
    expect((await B.pull(SID, homeB)).status).toBe("pulled");
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "workflows", RUN)).text()).toBe('{"runId":"wf_1"}');
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "workflows", SCRIPT)).text()).toBe("export const meta = {}\n");

    // tool-results が欠けていれば already-here にはならず、埋め直す
    await rm(join(homeB, "projects", encodeCwd(CWD_A), SID), { recursive: true, force: true });
    expect((await B.pull(SID, homeB)).status).toBe("pulled");
    expect(await Bun.file(join(homeB, "projects", encodeCwd(CWD_A), SID, "tool-results", "abc.txt")).exists()).toBe(true);

    await Bun.write(r.path, "something else\n");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/different content/);
    expect(await Bun.file(r.path).text()).toBe("something else\n");
    const forced = await B.pull(SID, homeB, true);
    expect(forced.status).toBe("pulled");
    expect(await Bun.file(r.path).text()).toBe(transcriptBody);
    // 押し退けた方は消えない
    expect(forced.replaced).toMatch(/\.replaced-\d+$/);
    expect(await Bun.file(forced.replaced!).text()).toBe("something else\n");

    await expect(B.pull("00000000-0000-4000-8000-000000000000", homeB)).rejects.toThrow(/not in the store/);
  });

  test("pull refuses to install a download that does not match session.json, and leaves no tmp", async () => {
    const t = await seedA();
    await A.push(t);
    await Bun.write(storedA(), (await Bun.file(storedA()).text()).replace("PORTABILITY-TEST-1", "PORTABILITY-TEST-X"));

    await expect(B.pull(SID, homeB)).rejects.toThrow(/does not match/);
    const path = join(homeB, "projects", encodeCwd(CWD_A), `${SID}.jsonl`);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(`${path}.pull-tmp`).exists()).toBe(false);

    // tool-results の破損も同じ (前の段で入った付属ファイルは消してから)
    const sessionDirB = join(homeB, "projects", encodeCwd(CWD_A), SID);
    await rm(sessionDirB, { recursive: true, force: true });
    await Bun.write(storedA(), transcriptBody);
    await Bun.write(join(root, "ccx", `${prefixA}tool-results/abc.txt`), "corrupt");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/tool-results\/abc.txt/);
    expect(await Bun.file(path).exists()).toBe(false);

    // subagents の破損も同じ
    await rm(sessionDirB, { recursive: true, force: true });
    await Bun.write(join(root, "ccx", `${prefixA}tool-results/abc.txt`), "big tool output");
    await Bun.write(join(root, "ccx", `${prefixA}subagents/${WF}`), "corrupt");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/subagents\/workflows\/wf_1\/agent-b2.jsonl/);
    expect(await Bun.file(path).exists()).toBe(false);
    const wfDest = join(homeB, "projects", encodeCwd(CWD_A), SID, "subagents", WF);
    expect(await Bun.file(wfDest).exists()).toBe(false);
    expect(await Bun.file(`${wfDest}.pull-tmp`).exists()).toBe(false);

    // workflows の破損も同じ
    await rm(sessionDirB, { recursive: true, force: true });
    await Bun.write(join(root, "ccx", `${prefixA}subagents/${WF}`), "workflow agent line\n");
    await Bun.write(join(root, "ccx", `${prefixA}workflows/${RUN}`), "corrupt");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/workflows\/wf_1.json/);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(join(sessionDirB, "workflows", RUN)).exists()).toBe(false);
    expect(await Bun.file(join(sessionDirB, "workflows", `${RUN}.pull-tmp`)).exists()).toBe(false);
    await Bun.write(join(root, "ccx", `${prefixA}workflows/${RUN}`), '{"runId":"wf_1"}');

    // 保存先が projectDir の外を指す名前を書いていても置かない
    const metaKey = join(root, "ccx", `${prefixA}session.json`);
    const meta = await Bun.file(metaKey).json();
    const outside = join(homeB, "projects", encodeCwd(CWD_A), "escape.jsonl");
    await Bun.write(outside, "must stay");
    await Bun.write(metaKey, JSON.stringify({ ...meta, subagents: [{ name: "../../escape.jsonl", sha256: "x" }] }));
    await expect(B.pull(SID, homeB)).rejects.toThrow(/refusing to install/);
    expect(await Bun.file(outside).text()).toBe("must stay");
    // workflows の名前も同じ
    await Bun.write(metaKey, JSON.stringify({ ...meta, workflows: [{ name: "../../escape.jsonl", sha256: "x" }] }));
    await expect(B.pull(SID, homeB)).rejects.toThrow(/refusing to install/);
    expect(await Bun.file(outside).text()).toBe("must stay");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("resolve turns the short id that ls prints into the full id, and refuses an ambiguous one", async () => {
    const t = await seedA();
    await A.push(t);
    expect(await A.resolve(SID.slice(0, 8))).toBe(SID);
    expect(await A.resolve(SID)).toBe(SID);
    expect(await A.resolve("ffffffff")).toBeNull();

    const other = `${SID.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`;
    await Bun.write(join(t.projectDir, `${other}.jsonl`), transcriptBody);
    const [t2] = (await localTranscripts(homeA)).filter((x) => x.sessionId === other);
    await A.push(t2!);
    await expect(A.resolve(SID.slice(0, 8))).rejects.toThrow(AmbiguousSessionId);
    expect(await A.resolve(SID.slice(0, 10))).toBe(SID);
    expect((await A.list("host-a")).length).toBe(2);
    expect((await A.list("host-z")).length).toBe(0);
  });

  test("find returns the newest copy when several machines pushed the same id; list sees them all", async () => {
    const t = await seedA();
    await A.push(t);
    // B が続きを書いて push (後の push)
    const grown = `${transcriptBody}${line({ type: "user", message: "continued on B" })}`;
    await Bun.write(t.path, grown);
    await new Promise((r) => setTimeout(r, 5));
    await B.push(t);

    expect((await A.list()).map((m) => m.machine).sort()).toEqual(["host-a", "host-b"]);
    const newest = await A.find(SID);
    expect(newest?.machine).toBe("host-b");
    expect(newest?.size).toBe(grown.length);
    expect((await A.findAll(SID)).map((m) => m.machine)).toEqual(["host-b", "host-a"]);
    expect(await B.find("00000000-0000-4000-8000-000000000000")).toBeNull();

    // pull は新しい方を取る
    const r = await B.pull(SID, homeB);
    expect(await Bun.file(r.path).text()).toBe(grown);
  });

  test("prune deletes only when a store copy reads back identical (any machine's), never a running session, and only its own files", async () => {
    const t = await seedA();

    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: "not in the store (push first)" });

    await A.push(t);
    // subagents を運ぶ前の写し (session.json に一覧が無い) は、手元に subagents があれば消さない
    const metaKey = join(root, "ccx", `${prefixA}session.json`);
    const current = await Bun.file(metaKey).text();
    const { subagents: _, ...old } = JSON.parse(current) as Record<string, unknown>;
    await Bun.write(metaKey, JSON.stringify(old));
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("before subagents were carried") });
    expect(await Bun.file(join(t.subagentsDir!, WF)).exists()).toBe(true);
    // workflows も同じ
    const { workflows: __, ...noWf } = JSON.parse(current) as Record<string, unknown>;
    await Bun.write(metaKey, JSON.stringify(noWf));
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("before workflows were carried") });
    expect(await Bun.file(join(t.workflowsDir!, RUN)).exists()).toBe(true);
    await Bun.write(metaKey, current);
    expect(await A.prune(t, new Set([SID]))).toMatchObject({ status: "refused", reason: "session is running" });
    expect(await Bun.file(t.path).exists()).toBe(true);

    // 保存先の写しを (同じ長さのまま) 壊す → 読み戻しで違いが出て消さない
    const good = await Bun.file(storedA()).text();
    await Bun.write(storedA(), good.replace("PORTABILITY-TEST-1", "PORTABILITY-TEST-X"));
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("does not read back") });
    expect(await Bun.file(t.path).exists()).toBe(true);
    await Bun.write(storedA(), good);

    // tool-results の実体が壊れていても消さない
    await Bun.write(join(root, "ccx", `${prefixA}tool-results/abc.txt`), "corrupt");
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("does not read back") });
    await Bun.write(join(root, "ccx", `${prefixA}tool-results/abc.txt`), "big tool output");

    // subagents の実体が壊れていても消さない
    await Bun.write(join(root, "ccx", `${prefixA}subagents/${WF}`), "corrupt");
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("does not read back") });
    await Bun.write(join(root, "ccx", `${prefixA}subagents/${WF}`), "workflow agent line\n");

    // workflows の実体が壊れていても消さない
    await Bun.write(join(root, "ccx", `${prefixA}workflows/${RUN}`), "corrupt");
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("does not read back") });
    await Bun.write(join(root, "ccx", `${prefixA}workflows/${RUN}`), '{"runId":"wf_1"}');

    // push 後に workflow の run が増えていても消さない
    await Bun.write(join(t.workflowsDir!, "wf_2.json"), "unpushed");
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("no copy in the store matches") });
    await rm(join(t.workflowsDir!, "wf_2.json"));

    // push 後に subagent が増えていても消さない
    await Bun.write(join(t.subagentsDir!, "agent-late.jsonl"), "unpushed");
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("no copy in the store matches") });
    await rm(join(t.subagentsDir!, "agent-late.jsonl"));

    // ローカルが push 後に進んでいても消さない (transcript でも tool-results でも)
    await Bun.write(t.path, `${transcriptBody}${line({ type: "user", message: "after push" })}`);
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("no copy in the store matches") });
    await Bun.write(t.path, transcriptBody);
    await Bun.write(join(t.toolResultsDir!, "new.txt"), "unpushed");
    expect(await A.prune(t, new Set())).toMatchObject({ status: "refused", reason: expect.stringContaining("no copy in the store matches") });
    await rm(join(t.toolResultsDir!, "new.txt"));

    // <projectDir>/<id>/ の他のものは残す
    await Bun.write(join(t.projectDir, SID, "other", "x.jsonl"), "keep");
    const r = await A.prune(t, new Set());
    expect(r.status).toBe("pruned");
    expect(await Bun.file(t.path).exists()).toBe(false);
    expect(await Bun.file(join(t.projectDir, SID, "tool-results", "abc.txt")).exists()).toBe(false);
    expect(await stat(join(t.projectDir, SID, "subagents")).catch(() => null)).toBeNull();
    expect(await stat(join(t.projectDir, SID, "workflows")).catch(() => null)).toBeNull();
    expect(await Bun.file(join(t.projectDir, SID, "other", "x.jsonl")).text()).toBe("keep");
    expect((await A.history(r.meta!)).map((e) => e.op)).toEqual(["push", "prune"]);

    // 消した後も保存先から戻せる
    expect((await A.pull(SID, homeA)).status).toBe("pulled");
    expect(await Bun.file(t.path).text()).toBe(transcriptBody);
    expect(await Bun.file(join(t.projectDir, SID, "subagents", WF)).text()).toBe("workflow agent line\n");
    expect(await Bun.file(join(t.projectDir, SID, "workflows", SCRIPT)).text()).toBe("export const meta = {}\n");
  });

  test("a copy pushed before workflows were carried still matches a session that has none (no re-push, prune goes through)", async () => {
    const t = await seedA();
    await rm(t.workflowsDir!, { recursive: true });
    const [t0] = await localTranscripts(homeA);
    expect(t0!.workflowsDir).toBeNull();
    await A.push(t0!);
    const metaKey = join(root, "ccx", `${prefixA}session.json`);
    const { workflows: _, ...old } = (await Bun.file(metaKey).json()) as Record<string, unknown>;
    await Bun.write(metaKey, JSON.stringify(old));

    expect((await A.push(t0!)).status).toBe("unchanged");

    // 手元の workflows が「ディレクトリでない」なら空と読まず (already-here にしない)、pull は止まる
    expect((await B.pull(SID, homeB)).status).toBe("pulled");
    await Bun.write(join(homeB, "projects", encodeCwd(CWD_A), SID, "workflows"), "not a dir");
    await expect(B.pull(SID, homeB)).rejects.toThrow(/ENOTDIR/);

    expect((await A.prune(t0!, new Set())).status).toBe("pruned");
  });

  test("prune on the machine that pulled (not the one that pushed) works, and folds an empty session dir", async () => {
    const t = await seedA();
    await A.push(t);
    const r = await B.pull(SID, homeB);
    const [tb] = await localTranscripts(homeB);
    expect(tb!.path).toBe(r.path);

    const pr = await B.prune(tb!, new Set());
    expect(pr.status).toBe("pruned");
    expect(pr.meta?.machine).toBe("host-a");
    expect(await Bun.file(r.path).exists()).toBe(false);
    expect(await stat(join(homeB, "projects", encodeCwd(CWD_A), SID)).catch(() => null)).toBeNull();
    expect((await B.history(pr.meta!)).map((e) => [e.op, e.machine])).toEqual([
      ["push", "host-a"],
      ["pull", "host-b"],
      ["prune", "host-b"],
    ]);
  });
});

describe("transcript: pull materialises a repodir for the session's repo", () => {
  const REMOTE = "https://github.com/test-owner/demo.git";
  let tmp: string;
  let savedGitConfig: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ccx-tr-repo-"));
    const git = (args: string[], cwd?: string) => Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
    const work = join(tmp, "work");
    await git(["init", "--quiet", "--initial-branch", "main", work]);
    await git(["config", "user.email", "t@example.com"], work);
    await git(["config", "user.name", "t"], work);
    await Bun.write(join(work, "README.md"), "# demo\n");
    await git(["add", "README.md"], work);
    await git(["commit", "--quiet", "-m", "init"], work);
    const source = join(tmp, "source.git");
    await git(["clone", "--quiet", "--bare", work, source]);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], source);
    // push 側の cwd: origin が REMOTE を指す clone。branch は feature で、default ではない
    const cwd = join(tmp, "cwd");
    await git(["clone", "--quiet", source, cwd]);
    await git(["remote", "set-url", "origin", REMOTE], cwd);
    await git(["switch", "--quiet", "-c", "feat/x"], cwd);
    const gitconfig = join(tmp, "gitconfig");
    await Bun.write(gitconfig, `[url "file://${source}"]\n\tinsteadOf = ${REMOTE}\n`);
    savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;

    const projectDir = join(homeA, "projects", encodeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${SID}.jsonl`), line({ type: "user", cwd, gitBranch: "feat/x", version: "1", message: "hi" }));
  });

  afterEach(async () => {
    if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
    await rm(tmp, { recursive: true, force: true });
  });

  test("push records host/owner/repo from origin; pull creates a repodir on the default branch and says where to resume", async () => {
    const [t] = await localTranscripts(homeA);
    const pushed = await A.push(t!);
    expect(pushed.meta.repo).toBe("github.com/test-owner/demo");
    expect(pushed.meta.gitBranch).toBe("feat/x");

    const ccxRoot = join(tmp, "repodirs");
    const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "pull", SID.slice(0, 8), "--json"], {
      env: {
        ...process.env,
        CCX_HUB_URL: A.store.endpoint,
        CCX_TRANSCRIPT_PREFIX: "p",
        CCX_ROOT: ccxRoot,
        CLAUDE_CONFIG_DIR: homeB,
        XDG_CONFIG_HOME: tmp,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: expect.any(String) });
    const r = JSON.parse(out) as { status: string; repodir?: string; path: string };
    expect(r.status).toBe("pulled");
    expect(r.repodir).toMatch(new RegExp(`^${ccxRoot}/github.com/test-owner/demo/`));
    // default branch の最新で、元の feat/x ではない
    const branch = Bun.spawn(["git", "-C", r.repodir!, "branch", "--show-current"], { stdout: "pipe" });
    expect((await new Response(branch.stdout).text()).trim()).toBe("main");
    expect(await Bun.file(join(r.repodir!, "README.md")).text()).toBe("# demo\n");
    // transcript は元の cwd の encoded dir に (id で引かれるので repodir と一致しなくてよい)
    expect(r.path).toBe(join(homeB, "projects", encodeCwd(join(tmp, "cwd")), `${SID}.jsonl`));
  });

  test("--no-repodir leaves the working tree alone; no repo recorded means no repodir", async () => {
    const [t] = await localTranscripts(homeA);
    await A.push(t!);
    const ccxRoot = join(tmp, "repodirs2");
    const run = (...args: string[]) =>
      Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "pull", SID, "--json", ...args], {
        env: { ...process.env, CCX_HUB_URL: A.store.endpoint, CCX_TRANSCRIPT_PREFIX: "p", CCX_ROOT: ccxRoot, CLAUDE_CONFIG_DIR: homeB, XDG_CONFIG_HOME: tmp },
        stdout: "pipe",
        stderr: "pipe",
      });
    const p = run("--no-repodir");
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect((JSON.parse(out) as { repodir?: string }).repodir).toBeUndefined();
    expect(await stat(join(ccxRoot, "github.com")).catch(() => null)).toBeNull();
  });
});
