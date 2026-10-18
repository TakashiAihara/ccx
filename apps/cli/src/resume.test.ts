/**
 * `ccx session resume` の手元の部分 (#261): 止まった session を herdr の workspace に開き直す。
 *
 * herdr は本物を呼ばず、引数で渡す runner の偽物で応答を固定する。herdr に何を渡し、その JSON を
 * どう読むかという境界がテスト対象なので、呼ばれた引数をそのまま記録して比べる。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDeclared } from "@ccx/core";

import { expandCommand, ResumeRefused, resumeSession, type Herdr } from "./resume.ts";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CWD = "/work/ccx-repo/01ABCDEF";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ccx-resume-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** 最初のレコードに cwd を持つ transcript を置く */
async function transcript(id = ID, cwd = CWD) {
  const dir = join(home, "projects", "-work-ccx-repo-01ABCDEF");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: "permission-mode", sessionId: id }),
      JSON.stringify({ type: "user", cwd, gitBranch: "main", version: "2.1.300", sessionId: id }),
      "",
    ].join("\n"),
  );
}

/** このテストのプロセス自身を、その session を動かしているプロセスとして登録する */
async function running(id = ID) {
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id }));
}

type Call = string[];

/**
 * herdr の偽物。`agentAfter` 回目の `pane get` から agent=claude を返す (Infinity なら返さない)
 */
function fakeHerdr(o: { agentAfter?: number; createCode?: number; runCode?: number } = {}) {
  const calls: Call[] = [];
  let gets = 0;
  const herdr: Herdr = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "workspace" && b === "create") {
      if (o.createCode) return { code: o.createCode, stdout: "", stderr: "server not running" };
      return {
        code: 0,
        stdout: JSON.stringify({ result: { workspace: { workspace_id: "wZZ" }, root_pane: { pane_id: "wZZ:p1" } } }),
        stderr: "",
      };
    }
    if (a === "pane" && b === "run") return o.runCode ? { code: o.runCode, stdout: "", stderr: "no such pane" } : { code: 0, stdout: "{}", stderr: "" };
    if (a === "pane" && b === "get") {
      gets++;
      const pane: Record<string, unknown> = { pane_id: "wZZ:p1" };
      if (gets >= (o.agentAfter ?? 1)) pane.agent = "claude";
      return { code: 0, stdout: JSON.stringify({ result: { pane } }), stderr: "" };
    }
    if (a === "pane" && b === "read") return { code: 0, stdout: "zsh: command not found: claude-resume\n", stderr: "" };
    return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { herdr, calls };
}

const base = { command: "claude --resume {session_id}", waitMs: 200, pollMs: 5 };

test("transcript の cwd で workspace を作り、id を埋めたコマンドを走らせ、agent=claude を待つ", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agentAfter: 3 });

  const r = await resumeSession({ ...base, sessionId: ID, home, herdr });

  expect(r).toEqual({ workspaceId: "wZZ", paneId: "wZZ:p1", cwd: CWD, label: "01ABCDEF" });
  expect(calls[0]).toEqual(["workspace", "create", "--cwd", CWD, "--label", "01ABCDEF", "--no-focus"]);
  expect(calls[1]).toEqual(["pane", "run", "wZZ:p1", `claude --resume ${ID}`]);
  expect(calls.slice(2)).toEqual([
    ["pane", "get", "wZZ:p1"],
    ["pane", "get", "wZZ:p1"],
    ["pane", "get", "wZZ:p1"],
  ]);
});

test("大文字の id も受け、小文字にして使う", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr();
  await resumeSession({ ...base, sessionId: ID.toUpperCase(), home, herdr });
  expect(calls[1]).toEqual(["pane", "run", "wZZ:p1", `claude --resume ${ID}`]);
});

test("label は cwd の末尾と宣言済みの label の先頭 24 文字", async () => {
  await transcript();
  await writeDeclared(ID, { label: "停止済みセッションを Web UI / ccx コマンドから再開する" }, home);
  const { herdr, calls } = fakeHerdr();

  const r = await resumeSession({ ...base, sessionId: ID, home, herdr });

  expect(r.label).toBe("01ABCDEF｜停止済みセッションを Web UI / ccx");
  expect(calls[0]).toEqual(["workspace", "create", "--cwd", CWD, "--label", "01ABCDEF｜停止済みセッションを Web UI / ccx", "--no-focus"]);
});

test("動いている session は開かない (exit 1、herdr を呼ばない)", async () => {
  await transcript();
  await running();
  const { herdr, calls } = fakeHerdr();

  const e = await resumeSession({ ...base, sessionId: ID, home, herdr }).catch((x: unknown) => x);

  expect(e).toBeInstanceOf(ResumeRefused);
  expect((e as ResumeRefused).exitCode).toBe(1);
  expect((e as Error).message).toContain("running");
  expect(calls).toEqual([]);
});

test("別の session が動いていても、対象が止まっていれば開く", async () => {
  await transcript();
  await running("ffffffff-ffff-4fff-8fff-ffffffffffff");
  const { herdr, calls } = fakeHerdr();
  await resumeSession({ ...base, sessionId: ID, home, herdr });
  expect(calls[0]?.[1]).toBe("create");
});

test("archived は force が無ければ開かない (exit 1、herdr を呼ばない)", async () => {
  await transcript();
  await writeDeclared(ID, { archived: true }, home);
  const { herdr, calls } = fakeHerdr();

  const e = await resumeSession({ ...base, sessionId: ID, home, herdr }).catch((x: unknown) => x);

  expect(e).toBeInstanceOf(ResumeRefused);
  expect((e as ResumeRefused).exitCode).toBe(1);
  expect((e as Error).message).toContain("archived");
  expect(calls).toEqual([]);
});

test("archived でも force なら開く", async () => {
  await transcript();
  await writeDeclared(ID, { archived: true }, home);
  const { herdr, calls } = fakeHerdr();
  await resumeSession({ ...base, sessionId: ID, home, herdr, force: true });
  expect(calls[1]).toEqual(["pane", "run", "wZZ:p1", `claude --resume ${ID}`]);
});

test("手元に transcript が無ければ開かない (exit 1、herdr を呼ばない)", async () => {
  const { herdr, calls } = fakeHerdr();

  const e = await resumeSession({ ...base, sessionId: ID, home, herdr }).catch((x: unknown) => x);

  expect(e).toBeInstanceOf(ResumeRefused);
  expect((e as ResumeRefused).exitCode).toBe(1);
  expect((e as Error).message).toContain("transcript");
  expect(calls).toEqual([]);
});

test("session id でないものは herdr を呼ばずに投げる", async () => {
  const { herdr, calls } = fakeHerdr();
  await expect(resumeSession({ ...base, sessionId: "../etc", home, herdr })).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("workspace を作れなければ exit 1 で herdr の stderr を言い、pane は触らない", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ createCode: 1 });

  const e = await resumeSession({ ...base, sessionId: ID, home, herdr }).catch((x: unknown) => x);

  expect(e).toBeInstanceOf(ResumeRefused);
  expect((e as ResumeRefused).exitCode).toBe(1);
  expect((e as Error).message).toContain("server not running");
  expect(calls.length).toBe(1);
});

test("pane run が失敗したら、workspace は作ったので exit 3 で、pane get は呼ばない", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ runCode: 1 });

  const e = await resumeSession({ ...base, sessionId: ID, home, herdr }).catch((x: unknown) => x);

  expect(e).toBeInstanceOf(ResumeRefused);
  expect((e as ResumeRefused).exitCode).toBe(3);
  expect((e as Error).message).toContain("no such pane");
  expect(calls.length).toBe(2);
});

test("待っても agent=claude にならなければ exit 3 で、pane に見えているものを添える", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agentAfter: Infinity });

  const e = await resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 60, pollMs: 5 }).catch((x: unknown) => x);

  expect(e).toBeInstanceOf(ResumeRefused);
  expect((e as ResumeRefused).exitCode).toBe(3);
  expect((e as Error).message).toContain("command not found: claude-resume");
  expect(calls.filter((c) => c[1] === "get").length).toBeGreaterThan(1);
  expect(calls.at(-1)).toEqual(["pane", "read", "wZZ:p1", "--source", "visible"]);
});

test("expandCommand は {session_id} を全部置き換え、$ の並びを特別扱いしない", () => {
  expect(expandCommand("a {session_id} b {session_id} $& $1", ID)).toBe(`a ${ID} b ${ID} $& $1`);
  expect(expandCommand("claude-resume", ID)).toBe("claude-resume");
});
