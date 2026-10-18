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

import { findLocalTranscript } from "@ccx/core";

import { expandCommand, ResumeError, resumeSession, runHerdr, STABLE_MS, type Herdr, type HerdrResult } from "./resume.ts";

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
function fakeHerdr(o: { agents?: string[]; create?: HerdrResult; run?: HerdrResult; readFails?: boolean } = {}) {
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
      // 失敗した呼び出しが agent=claude を含む stdout を返しても、数えないことを見るため
      if (agent === "!") return { code: 1, stdout: JSON.stringify({ result: { pane: { agent: "claude" } } }), stderr: "busy" };
      const pane: Record<string, unknown> = { pane_id: "wZZ:p1" };
      if (agent) pane.agent = agent;
      return ok({ result: { pane } });
    }
    if (a === "pane" && b === "read") {
      if (o.readFails) return { code: 1, stdout: "", stderr: "pane gone" };
      const lines = Array.from({ length: 24 }, (_, i) => `line${i + 1}`);
      return { code: 0, stdout: [...lines, "zsh: command not found: claude-resume", ""].join("\n"), stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { herdr, calls };
}

const base = { command: "claude --resume {session_id}", waitMs: 200, pollMs: 5, stableMs: 0 };

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

test("pane get が答えられなかった回は数えず、並びも切らない", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["claude", "!", "claude", "claude"] });
  await resumeSession({ ...base, sessionId: ID, home, herdr });
  expect(calls.filter((c) => c[1] === "get").length).toBe(3);
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

  await writeFile(join(home, "sessions", ID, "label"), " \n\t ");
  const two = fakeHerdr();
  expect((await resumeSession({ ...base, sessionId: ID, home, herdr: two.herdr })).label).toBe("01ABCDEF");
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

test("create の答えに pane id だけ / workspace id だけが無くても exit 4", async () => {
  await transcript();
  for (const result of [{ workspace: { workspace_id: "wZZ" } }, { root_pane: { pane_id: "wZZ:p1" } }]) {
    const { herdr } = fakeHerdr({ create: ok({ result }) });
    const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
    expect(e.exitCode).toBe(4);
  }
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

test("続かずに 2 回見えても、上がったとは読まない", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ agents: ["claude", "", "claude", ""] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 60, pollMs: 5 }));
  expect(e.exitCode).toBe(4);
});

test("締め切りの時点で 1 回見えていれば、確かめの 1 回を待って開けたとする", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["claude", "claude"] });
  await resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 0, pollMs: 5 });
  expect(calls.filter((c) => c[1] === "get").length).toBe(2);
});

test("締め切りの後に herdr が答えなくなっても、stableMs を過ぎたら止める", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ agents: ["claude", "!"] });
  const t0 = Date.now();
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 0, stableMs: 30 }));
  expect(e.exitCode).toBe(4);
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("締め切りの時点で 1 度も見えていなければ、そこで止める", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["", "claude", "claude"] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 0, pollMs: 5 }));
  expect(e.exitCode).toBe(4);
  expect(calls.filter((c) => c[1] === "get").length).toBe(1);
});

test("pane に見えているものは末尾の 20 行", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ agents: [""] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 0 }));
  expect(e.message).toContain("line6\n");
  expect(e.message).not.toContain("line5\n");
  expect(e.message).toContain("command not found: claude-resume");
});

test("pane を読めなければ、herdr の答えを pane の中身としては出さない", async () => {
  await transcript();
  const { herdr } = fakeHerdr({ agents: [""], readFails: true });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 0 }));
  expect(e.message).toContain("the pane could not be read: pane gone");
  expect(e.message).not.toContain("what the pane shows");
});

test("見え続ける時間は 5 秒", () => {
  expect(STABLE_MS).toBe(5000);
});

test("見えてから stableMs 経つまでは開けたとしない", async () => {
  await transcript();
  const t0 = Date.now();
  const { herdr, calls } = fakeHerdr({ agents: ["claude"] });
  await resumeSession({ ...base, sessionId: ID, home, herdr, stableMs: 60 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
  expect(calls.filter((c) => c[1] === "get").length).toBeGreaterThan(2);
});

test("stableMs の間に途切れたら、締め切り後でも開けたとしない", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["claude", "claude", "claude", ""] });
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr, waitMs: 0, stableMs: 1000 }));
  expect(e.exitCode).toBe(4);
  expect(calls.filter((c) => c[1] === "get").length).toBe(4);
});

test("途切れたら、見え続ける時間は見え直したところから数え直す", async () => {
  await transcript();
  const { herdr, calls } = fakeHerdr({ agents: ["claude", "claude", "", "claude"] });
  await resumeSession({ ...base, sessionId: ID, home, herdr, pollMs: 10, stableMs: 25 });
  // 見え直した 4 回目から 25ms 以上: 最初から数えていれば 5 回目で開けたことになる
  expect(calls.filter((c) => c[1] === "get").length).toBeGreaterThanOrEqual(6);
});

test("cwd がディレクトリでなくファイルなら開かない (exit 1)", async () => {
  const file = join(home, "afile");
  await writeFile(file, "x");
  await transcript(ID, file);
  const { herdr, calls } = fakeHerdr();
  const e = await failure(resumeSession({ ...base, sessionId: ID, home, herdr }));
  expect(e.exitCode).toBe(1);
  expect(calls).toEqual([]);
});

test("findLocalTranscript は見つけた transcript のパスを返し、無ければ null", async () => {
  await mkdir(join(home, "projects", "-a"), { recursive: true });
  await transcript();
  expect(await findLocalTranscript(ID, home)).toBe(join(home, "projects", "-work-01ABCDEF", `${ID}.jsonl`));
  expect(await findLocalTranscript("ffffffff-ffff-4fff-8fff-ffffffffffff", home)).toBeNull();
});

test("runHerdr は TERM を握る子も時間で止め、timedOut を返す", async () => {
  const bin = join(home, "slow");
  await writeFile(bin, `#!/bin/sh\necho $$ > "${join(home, "slow.pid")}"\ntrap '' TERM\nexec sleep 5\n`);
  await chmod(bin, 0o755);
  const t0 = Date.now();
  const r = await runHerdr(["workspace", "create"], 200, bin);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2000);
  const pid = Number(await Bun.file(join(home, "slow.pid")).text());
  await Bun.sleep(100);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("runHerdr は stdout を持ったままの孫を待たずに返る", async () => {
  const bin = join(home, "forks");
  await writeFile(bin, `#!/bin/sh\nsleep 5 &\necho $! > "${join(home, "grandchild.pid")}"\nexec sleep 5\n`);
  await chmod(bin, 0o755);
  const t0 = Date.now();
  const r = await runHerdr(["workspace", "create"], 200, bin);
  const grandchild = Number(await Bun.file(join(home, "grandchild.pid")).text());
  process.kill(grandchild, "SIGKILL");
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("runHerdr は起動できなければ code 127", async () => {
  const r = await runHerdr(["x"], 200, join(home, "no-such-herdr"));
  expect(r.code).toBe(127);
  expect(r.timedOut).toBeUndefined();
});

test("expandCommand は {session_id} を全部置き換える", () => {
  expect(expandCommand("a {session_id} b {session_id}", ID)).toBe(`a ${ID} b ${ID}`);
});

// --- CLI の配線: 偽の herdr を PATH に置いて本物のコマンドを走らせる ---

const CLI = join(import.meta.dir, "index.ts");

async function cli(args: string[], herdrScript: string, extraEnv: Record<string, string> = {}) {
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
      CCX_AGENT: "",
      CCX_RESUME_AGENT: "",
      // 手元の git config (ccx.resumeCommand / ccx.agent) を読ませない
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...extraEnv,
    },
    // repo の checkout の外で走らせる (repo の .git/config の ccx.* を読ませない)
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const CREATE_JSON = `{"result":{"workspace":{"workspace_id":"wZZ"},"root_pane":{"pane_id":"wZZ:p1"}}}`;

test("CLI: 開けたら exit 0、先頭一致の id を解いて開く", async () => {
  await transcript();
  const t0 = Date.now();
  const r = await cli([ID.slice(0, 8), "--json"], `case "$1 $2" in "workspace create") echo '${CREATE_JSON}';; "pane get") echo '{"result":{"pane":{"agent":"claude"}}}';; *) echo '{}';; esac`);
  expect(r.code).toBe(0);
  // 既定の STABLE_MS (5 秒) を待ってから開けたとする
  expect(Date.now() - t0).toBeGreaterThanOrEqual(5000);
  expect(JSON.parse(r.stdout)).toEqual({ workspaceId: "wZZ", paneId: "wZZ:p1", cwd, label: "01ABCDEF" });
}, 15_000);

test("CLI: --force で archived を開き、--json が無ければ 1 行で言う", async () => {
  await transcript();
  await writeDeclared(ID, { archived: true }, home);
  const r = await cli([ID, "--force"], `case "$1 $2" in "workspace create") echo '${CREATE_JSON}';; "pane get") echo '{"result":{"pane":{"agent":"claude"}}}';; *) echo '{}';; esac`);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(`opened wZZ pane=wZZ:p1 01ABCDEF (${cwd})\n`);
}, 15_000);

test("CLI: agent が上がらなければ exit 4 で、--json は workspace の id を出す", async () => {
  await transcript();
  const r = await cli([ID, "--json", "--wait", "0.05"], `case "$1 $2" in "workspace create") echo '${CREATE_JSON}';; "pane get") echo '{"result":{"pane":{}}}';; *) echo '{}';; esac`);
  expect(r.code).toBe(4);
  expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 4, workspaceId: "wZZ", paneId: "wZZ:p1" });
  expect(r.stderr).toContain("herdr workspace close wZZ");
});

test("CLI: 待つ agent の名前は [resume] agent (CCX_RESUME_AGENT) から読む", async () => {
  await transcript();
  const r = await cli([ID, "--wait", "0.05"], `case "$1 $2" in "workspace create") echo '${CREATE_JSON}';; "pane get") echo '{"result":{"pane":{"agent":"claude"}}}';; *) echo '{}';; esac`, { CCX_RESUME_AGENT: "codex" });
  expect(r.code).toBe(4);
  expect(r.stderr).toContain("agent=codex");
});

test("CLI: 設定が読めなくても --json は失敗の形を出す", async () => {
  const bad = join(home, "bad.toml");
  await writeFile(bad, "[resume\n");
  const r = await cli([ID, "--json"], `echo called >&2`, { CCX_CONFIG: bad });
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 1 });
  expect(r.stderr).not.toContain("called");
});

test("CLI: --wait は 3600 秒まで", async () => {
  const r = await cli([ID, "--wait", "3601"], `echo called >&2`);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("--wait must be");
  expect(r.stderr).not.toContain("called");
});

test("CLI: 開く前に止めたら exit 1 で、herdr を呼ばない", async () => {
  const r = await cli([ID, "--json"], `echo called >&2; exit 9`);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 1 });
  expect(JSON.parse(r.stdout).error).toContain("no local transcript");
  expect(r.stderr).toContain("no local transcript");
  expect(r.stderr).not.toContain("called");
});
