/**
 * `ccx session resume` の手元の部分 (#261): 止まった session を herdr の workspace に開き直す。
 *
 * herdr は本物を呼ばず、引数で渡す runner の偽物で応答を固定する。herdr に何を渡し、その JSON を
 * どう読むかという境界がテスト対象なので、呼ばれた引数をそのまま記録して比べる。CLI の配線 (exit code と
 * --json) は、PATH に置いた偽の herdr で本物のコマンドを走らせて見る。
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDeclared } from "@ccx/core";

import { expandCommand, ResumeError, resumeSession, type Herdr, type HerdrResult } from "./resume.ts";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ccx-resume-"));
  cwd = join(home, "work", "01ABCDEF");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** 最初のレコードに cwd を持つ transcript を置く */
async function transcript(id = ID, dir = cwd) {
  const p = join(home, "projects", "-work-01ABCDEF");
  await mkdir(p, { recursive: true });
  await writeFile(
    join(p, `${id}.jsonl`),
    [
      JSON.stringify({ type: "permission-mode", sessionId: id }),
      JSON.stringify({ type: "user", cwd: dir, gitBranch: "main", version: "2.1.300", sessionId: id }),
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

const ok = (o: unknown): HerdrResult => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
const CREATED = ok({ result: { workspace: { workspace_id: "wZZ" }, root_pane: { pane_id: "wZZ:p1" } } });

/**
 * herdr の偽物。`pane get` の応答を `agents` の順に返す (尽きたら最後の値を繰り返す)。
 * 値が "!" なら code 1 で失敗を返す
 */
function fakeHerdr(o: { agents?: string[]; create?: HerdrResult; run?: HerdrResult } = {}) {
  const calls: Call[] = [];
  const agents = o.agents ?? ["claude"];
  let gets = 0;
  const herdr: Herdr = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "workspace" && b === "create") return o.create ?? CREATED;
    if (a === "pane" && b === "run") return o.run ?? ok({});
    if (a === "pane" && b === "get") {
      const agent = agents[Math.min(gets++, agents.length - 1)]!;
      if (agent === "!") return { code: 1, stdout: "", stderr: "busy" };
      const pane: Record<string, unknown> = { pane_id: "wZZ:p1" };
      if (agent) pane.agent = agent;
      return ok({ result: { pane } });
    }
    if (a === "pane" && b === "read") return { code: 0, stdout: "line1\nzsh: command not found: claude-resume\n", stderr: "" };
    return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { herdr, calls };
}

const base = { command: "claude --resume {session_id}", waitMs: 200, pollMs: 5 };

async function failure(p: Promise<unknown>): Promise<ResumeError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ResumeError);
  return e as ResumeError;
}

test("transcript の cwd で workspace を作り、id を埋めたコマンドを走らせ、agent=claude が 2 回続くまで待つ", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["", "claude", "", "claude", "claude"] });

  const r = await resumeSession({ ...base, sessionId: ID, home, herdr });

  expect(r).toEqual({ workspaceId: "wZZ", paneId: "wZZ:p1", cwd, label: "01ABCDEF" });
  expect(calls[0]).toEqual(["workspace", "create", "--cwd", cwd, "--label", "01ABCDEF", "--no-focus"]);
  expect(calls[1]).toEqual(["pane", "run", "wZZ:p1", `claude --resume ${ID}`]);
  expect(calls.slice(2).length).toBe(5);
  expect(calls.slice(2).every((c) => c.join(" ") === "pane get wZZ:p1")).toBe(true);
});

test("pane get の失敗は 2 回続けての数を切る", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["claude", "!", "claude", "claude"] });
  await resumeSession({ ...base, sessionId: ID, home, herdr });
  expect(calls.filter((c) => c[1] === "get").length).toBe(4);
});

test("待つ agent の名前は agent で変えられる", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ agents: ["claude"] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, agent: "codex", waitMs: 30 }));
  expect(e.exitCode).toBe(4);
  expect(e.message).toContain("agent=codex");

  const ok2 = fakeHerdr({ agents: ["codex"] });
  await resumeSession({ ...base, sessionId: ID, home, herdr: ok2.herdr, agent: "codex" });
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
  expect(calls[0]?.[5]).toBe("01ABCDEF｜停止済みセッションを Web UI / ccx");
});

test("label の改行・連続した空白は 1 つの空白にし、空白だけなら cwd の末尾だけ", async () => {
  await transcript();
  await writeDeclared(ID, { label: "  a\n\tb  " }, home);
  const one = fakeHerdr();
  expect((await resumeSession({ ...base, sessionId: ID, home, herdr: one.herdr })).label).toBe("01ABCDEF｜a b");
});

test("動いている session は開かない (exit 1、herdr を呼ばない)", async () => {
  await transcript();
  await running();
  const { herdr, calls } = fakeHerdr();
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("running");
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
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("archived");
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
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("no local transcript");
  expect(calls).toEqual([]);
});

test("transcript の cwd がもう無ければ開かない (exit 1、herdr を呼ばない)", async () => {
  await transcript(ID, join(home, "gone"));
  const { herdr, calls } = fakeHerdr();
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("no longer a directory");
  expect(calls).toEqual([]);
});

test("transcript が cwd を持たなければ開かない (exit 1)", async () => {
  const p = join(home, "projects", "-x");
  await mkdir(p, { recursive: true });
  await writeFile(join(p, `${ID}.jsonl`), JSON.stringify({ type: "permission-mode", sessionId: ID }) + "\n");
  const { herdr, calls } = fakeHerdr();
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("records no cwd");
  expect(calls).toEqual([]);
});

test("session id でないものは、何も読まずに exit 1 で止める", async () => {
  const { herdr, calls } = fakeHerdr();
  const e = await failure(resumeSession({ ...base, sessionId: "../etc", home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("not a session id");
  expect(calls).toEqual([]);
});

test("{session_id} の無いコマンド (空を含む) は workspace を作る前に exit 1", async () => {
  await transcript();
  for (const command of ["", "claude-resume"]) {
    const { herdr, calls } = fakeHerdr();
    const e = await failure(resumeSession({ ...base, command, sessionId: ID, home, herdr }));
    expect(e.exitCode).toBe(1);
    expect(e.message).toContain("{session_id}");
    expect(calls).toEqual([]);
  }
});

test("workspace を作れなければ exit 1 で herdr の stderr を言い、pane は触らない", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ create: { code: 1, stdout: "", stderr: "server not running" } });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(e.message).toContain("server not running");
  expect(calls.length).toBe(1);
});

test("create が成功したのに id が読めなければ、workspace は残っているとして exit 4", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ create: { code: 0, stdout: '{"result":{}}', stderr: "" } });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(4);
  expect(e.message).toContain("likely left");
  expect(calls.length).toBe(1);
});

test("create が時間内に答えなければ exit 4 (作られたかもしれない)", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ create: { code: 143, stdout: "", stderr: "", timedOut: true } });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(4);
  expect(e.message).toContain("may have been created");
});

test("pane run が失敗したら exit 4 で workspace の id と閉じ方を言い、pane get は呼ばない", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ run: { code: 1, stdout: "", stderr: "no such pane" } });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(4);
  expect(e.created).toEqual({ workspaceId: "wZZ", paneId: "wZZ:p1" });
  expect(e.message).toContain("no such pane");
  expect(e.message).toContain("herdr workspace close wZZ");
  expect(calls.length).toBe(2);
});

test("待っても agent=claude にならなければ exit 4 で、pane に見えているものと閉じ方を添える", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: [""] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 60, pollMs: 5 }));
  expect(e.exitCode).toBe(4);
  expect(e.created).toEqual({ workspaceId: "wZZ", paneId: "wZZ:p1" });
  expect(e.message).toContain("command not found: claude-resume");
  expect(e.message).toContain("herdr workspace close wZZ");
  expect(calls.filter((c) => c[1] === "get").length).toBeGreaterThan(1);
  expect(calls.at(-1)).toEqual(["pane", "read", "wZZ:p1", "--source", "visible"]);
});

test("1 回だけ agent=claude が見えて消えたら、上がったとは読まない", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ agents: ["claude", ""] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 60, pollMs: 5 }));
  expect(e.exitCode).toBe(4);
});

test("expandCommand は {session_id} を全部置き換える", () => {
  expect(expandCommand("a {session_id} b {session_id}", ID)).toBe(`a ${ID} b ${ID}`);
});

// --- CLI の配線: 偽の herdr を PATH に置いて本物のコマンドを走らせる ---

const CLI = join(import.meta.dir, "index.ts");

async function cli(args: string[], herdrScript: string) {
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "herdr"), `#!/bin/sh\n${herdrScript}\n`);
  await chmod(join(bin, "herdr"), 0o755);
  const proc = Bun.spawn(["bun", CLI, "session", "resume", ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: home,
      CCX_CONFIG: join(home, "absent.toml"),
      XDG_CONFIG_HOME: join(home, "xdg"),
      CCX_RESUME_COMMAND: "",
      CCX_HUB_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const CREATE_JSON = `{"result":{"workspace":{"workspace_id":"wZZ"},"root_pane":{"pane_id":"wZZ:p1"}}}`;

test("CLI: 開けたら exit 0、先頭一致の id を解いて開く", async () => {
  await transcript();
  const r = await cli([ID.slice(0, 8), "--json"], `case "$1 $2" in "workspace create") echo '${CREATE_JSON}';; "pane get") echo '{"result":{"pane":{"agent":"claude"}}}';; *) echo '{}';; esac`);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ workspaceId: "wZZ", paneId: "wZZ:p1", cwd, label: "01ABCDEF" });
});

test("CLI: agent が上がらなければ exit 4 で、--json は workspace の id を出す", async () => {
  await transcript();
  const r = await cli([ID, "--json", "--wait", "0.05"], `case "$1 $2" in "workspace create") echo '${CREATE_JSON}';; "pane get") echo '{"result":{"pane":{}}}';; *) echo '{}';; esac`);
  expect(r.code).toBe(4);
  expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 4, workspaceId: "wZZ", paneId: "wZZ:p1" });
  expect(r.stderr).toContain("herdr workspace close wZZ");
});

test("CLI: 開く前に止めたら exit 1 で、herdr を呼ばない", async () => {
  const r = await cli([ID, "--json"], `echo called >&2; exit 9`);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 1 });
  expect(r.stderr).not.toContain("called");
});
