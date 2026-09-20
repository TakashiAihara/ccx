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

import { declaredFor, lifecycleOf } from "./session-state.ts";
import { select } from "./transcript.ts";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const SID2 = "1f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const SID3 = "2f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
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
    // 印が 1 つも無ければ state.json を置かない (無い = 空)
    expect((await A.push(t, homeA)).status).toBe("pushed");
    expect(await Bun.file(stateKey()).exists()).toBe(false);
    expect(await A.readRemoteDeclared(SID)).toBeNull();

    await writeDeclared(SID, { archived: true, label: "L", task: "kaneo ccx#1" }, homeA);
    const r1 = await A.push(t, homeA);
    expect(r1.status).toBe("state");
    expect(r1.state).toEqual({ archived: true, label: "L", task: "kaneo ccx#1" });
    expect(await Bun.file(stateKey()).json()).toEqual(r1.state);
    expect(await A.readRemoteDeclared(SID)).toEqual(r1.state);

    expect((await A.push(t, homeA)).status).toBe("unchanged");

    await writeDeclared(SID, { task: "kaneo ccx#2" }, homeA);
    const r2 = await A.push(t, homeA);
    expect(r2.status).toBe("state");
    expect((await Bun.file(stateKey()).json()).task).toBe("kaneo ccx#2");
    // transcript は置き直していないが、印が変わったことは履歴に残る
    expect((await A.history(r2.meta)).map((e) => e.op)).toEqual(["push", "state", "state"]);

    // 印を外しても運ぶ (「無い」ではなく「false」を置く)
    await writeDeclared(SID, { archived: false, label: "", task: "" }, homeA);
    expect((await A.push(t, homeA)).status).toBe("state");
    expect(await A.readRemoteDeclared(SID)).toEqual(EMPTY_DECLARED);
  });

  test("pull installs the store's state as local marks on a fresh machine, but never over marks this machine already holds", async () => {
    const t = await seed(homeA, SID);
    await writeDeclared(SID, { archived: true, label: "L" }, homeA);
    await A.push(t, homeA);

    const r = await B.pull(SID, homeB);
    expect(r.status).toBe("pulled");
    expect(r.stateApplied).toBe(true);
    expect(r.state).toEqual({ archived: true, label: "L", task: "" });
    expect(await readDeclared(SID, homeB)).toEqual(r.state!);
    expect(await Bun.file(join(homeB, "sessions", SID, "archived")).exists()).toBe(true);

    // B で印を変えてから再度 pull (already-here) しても、B の印は保存先の古い写しで消えない
    await writeDeclared(SID, { archived: false, task: "kaneo ccx#9" }, homeB);
    const again = await B.pull(SID, homeB);
    expect(again.status).toBe("already-here");
    expect(again.stateApplied).toBe(false);
    expect(again.state?.archived).toBe(true);
    expect(await readDeclared(SID, homeB)).toEqual({ archived: false, label: "L", task: "kaneo ccx#9" });

    // transcript より先に印だけ付けたマシンに pull しても、その印は残る (保存先の写しは適用しない)
    await rm(join(homeB, "projects"), { recursive: true, force: true });
    await writeDeclared(SID, { archived: false, label: "", task: "mine" }, homeB);
    const pre = await B.pull(SID, homeB);
    expect(pre.status).toBe("pulled");
    expect(pre.stateApplied).toBe(false);
    expect(await readDeclared(SID, homeB)).toEqual({ ...EMPTY_DECLARED, task: "mine" });
  });

  test("a session pushed before state.json existed pulls with state null and leaves local marks alone", async () => {
    const t = await seed(homeA, SID);
    await writeDeclared(SID, { archived: true }, homeA);
    await A.push(t, homeA);
    await rm(stateKey());
    expect(await A.readRemoteDeclared(SID)).toBeNull();
    await writeDeclared(SID, { task: "mine" }, homeB);
    const r = await B.pull(SID, homeB);
    expect(r.status).toBe("pulled");
    expect(r.state).toBeNull();
    expect(await readDeclared(SID, homeB)).toEqual({ ...EMPTY_DECLARED, task: "mine" });
  });

  test("lifecycle: running by pid, ended by a local transcript, remote by the store (any machine's copy, or one origin's), unknown otherwise", async () => {
    const t = await seed(homeA, SID);
    expect(await lifecycleOf(SID, new Set([SID]), true, A)).toBe("running");
    expect(await lifecycleOf(SID, new Set(), true, A)).toBe("ended");
    // 手元に無く、保存先にも無い → unknown。保存先が無い → unknown (「無い」とは言わない)
    expect(await lifecycleOf(SID, new Set(), false, A)).toBe("unknown");
    expect(await lifecycleOf(SID, new Set(), false, null)).toBe("unknown");
    await A.push(t, homeA);
    expect(await lifecycleOf(SID, new Set(), false, A)).toBe("remote");
    // 別マシンが push した写しでも remote (origin 無し = 全 machine を探す)
    expect(await lifecycleOf(SID, new Set(), false, B)).toBe("remote");
    // origin を渡せばその下だけ: host-a の写しは host-b の下には無い
    expect(await lifecycleOf(SID, new Set(), false, B, { machine: "host-a", user: "alice" })).toBe("remote");
    expect(await lifecycleOf(SID, new Set(), false, B, { machine: "host-b", user: "bob" })).toBe("unknown");
  });

  test("declaredFor shows local marks first, and the store's state.json only for a remote session with no local marks", async () => {
    const t = await seed(homeA, SID);
    await writeDeclared(SID, { archived: true, label: "L" }, homeA);
    await A.push(t, homeA);
    // 手元に印がある → 手元 (保存先とは違えても)
    await writeDeclared(SID, { label: "newer" }, homeA);
    expect((await declaredFor(SID, homeA, "ended", A)).label).toBe("newer");
    // remote で手元に印が無い → 保存先
    expect(await declaredFor(SID, homeB, "remote", B)).toEqual({ archived: true, label: "L", task: "" });
    expect(await declaredFor(SID, homeB, "remote", B, { machine: "host-a", user: "alice" })).toEqual({ archived: true, label: "L", task: "" });
    // remote でなければ保存先は見ない。保存先が無ければ手元 (空)
    expect(await declaredFor(SID, homeB, "unknown", B)).toEqual(EMPTY_DECLARED);
    expect(await declaredFor(SID, homeB, "remote", null)).toEqual(EMPTY_DECLARED);
  });
});

describe("select: --ended / --archived", () => {
  test("--archived picks archived sessions (running included for push, excluded for prune); --ended --archived is the intersection", async () => {
    await seed(homeA, SID, "one");
    await seed(homeA, SID2, "two");
    // SID3: ended だが archived ではない。--ended と --ended --archived を区別するための対照
    await seed(homeA, SID3, "three");
    await writeDeclared(SID, { archived: true }, homeA);
    // SID2 を「動いている」に見せる
    await mkdir(join(homeA, "sessions"), { recursive: true });
    await Bun.write(join(homeA, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SID2 }));
    await writeDeclared(SID2, { archived: true }, homeA);

    const ids = (r: { picked: LocalTranscript[] }) => r.picked.map((t) => t.sessionId).sort();
    expect(ids(await select([], { archived: true }, { home: homeA }))).toEqual([SID, SID2]);
    expect(ids(await select([], { archived: true }, { home: homeA, excludeRunning: true }))).toEqual([SID]);
    expect(ids(await select([], { ended: true }, { home: homeA }))).toEqual([SID, SID3]);
    expect(ids(await select([], { ended: true, archived: true }, { home: homeA }))).toEqual([SID]);

    await writeDeclared(SID, { archived: false }, homeA);
    expect(ids(await select([], { archived: true }, { home: homeA }))).toEqual([SID2]);
    expect(ids(await select([], { ended: true, archived: true }, { home: homeA }))).toEqual([]);

    // 明示の id は選択子を要らない。何も無ければ止まる
    expect(ids(await select([SID.slice(0, 8)], {}, { home: homeA }))).toEqual([SID]);
    await expect(select([], {}, { home: homeA })).rejects.toThrow(/--ended .* --archived/);
  });
});

describe("ccx session (the CLI itself, no center, no store)", () => {
  const cli = join(import.meta.dir, "index.ts");
  async function run(args: string[], env: Record<string, string> = {}) {
    const p = Bun.spawn(["bun", "run", cli, "session", ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: homeA, CCX_HUB_URL: "", CCX_TRANSCRIPT_ENDPOINT: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  }

  test("mark / --off / label '' / task / status resolve the id from the argument, a prefix, or CLAUDE_CODE_SESSION_ID", async () => {
    await seed(homeA, SID);
    // 引数無し + env 無し → 止まる
    const none = await run(["mark", "archived"], { CLAUDE_CODE_SESSION_ID: "" });
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/CLAUDE_CODE_SESSION_ID/);

    expect((await run(["mark", "archived"], { CLAUDE_CODE_SESSION_ID: SID })).code).toBe(0);
    expect((await run(["label", "scope｜step", SID.slice(0, 8)])).code).toBe(0);
    expect((await run(["task", "kaneo ccx#1", SID])).code).toBe(0);
    expect(await readDeclared(SID, homeA)).toEqual({ archived: true, label: "scope｜step", task: "kaneo ccx#1" });

    expect((await run(["mark", "archived", "--off", SID])).code).toBe(0);
    expect((await run(["label", "", SID])).code).toBe(0);
    expect(await readDeclared(SID, homeA)).toEqual({ ...EMPTY_DECLARED, task: "kaneo ccx#1" });

    // remote は観測、done は利用者側の marker: どちらも mark できない
    for (const word of ["remote", "done"]) {
      const bad = await run(["mark", word, SID]);
      expect(bad.code).toBe(1);
      expect(bad.err).toMatch(new RegExp(`unknown flag ${word}`));
    }
    expect((await run(["mark", "archived", "ffffffff"])).err).toMatch(/no local session matches ffffffff/);

    // status: 保存先が無いので lifecycle は手元から (transcript あり = ended)。--json の形は mark と同じ鍵 + lifecycle
    const st = await run(["status", SID.slice(0, 8), "--json"]);
    expect(st.code).toBe(0);
    expect(JSON.parse(st.out)).toEqual({ sessionId: SID, lifecycle: "ended", ...EMPTY_DECLARED, task: "kaneo ccx#1" });
    const mark = await run(["mark", "archived", SID, "--json"]);
    expect(Object.keys(JSON.parse(mark.out))).toEqual(["sessionId", "archived", "label", "task"]);
    expect((await run(["status", SID])).out).toMatch(/lifecycle\s+ended\n.*flags\s+archived/);
  });
});
