/**
 * Runs `ccx rd ls` as a CLI to pin the --branch wiring (#280): the flag reaches the scan for
 * both the table and --json, and an empty pattern is refused.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepodir, git, parseRepoSpec, type Config } from "@ccx/core";

const REMOTE = "https://github.com/test-owner/demo.git";
const cli = join(import.meta.dir, "index.ts");

let tmp: string;
let cfg: Config;
let gitconfig: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-ls-"));
  const work = join(tmp, "work");
  const source = join(tmp, "source.git");
  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["clone", "--quiet", "--bare", work, source]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], source);
  gitconfig = join(tmp, "gitconfig");
  await Bun.write(gitconfig, `[url "file://${source}"]\n\tinsteadOf = ${REMOTE}\n`);
  cfg = {
    root: join(tmp, "repodirs"),
    mirrorRoot: join(tmp, "repodirs", ".mirror"),
    defaultHost: "github.com",
    machine: "test-machine",
    protocol: "https",
    mirrorMaxAgeMs: 600_000,
    defaults: { agent: "claude" },
    resume: { command: "claude --resume {session_id}", agent: "claude" },
  };
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function ccxLs(...args: string[]) {
  const p = Bun.spawn(["bun", "run", cli, "rd", "ls", ...args], {
    env: { ...process.env, CCX_ROOT: cfg.root, GIT_CONFIG_GLOBAL: gitconfig, XDG_CONFIG_HOME: tmp, CCX_HUB_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("rd ls --branch keeps only repodirs on a matching branch, in the table and in --json (#280)", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  const spec = parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });
  let onMain: string;
  let onFix: string;
  try {
    onMain = (await createRepodir(cfg, spec, { initialTask: "on main" }, "0.1.0")).path;
    onFix = (await createRepodir(cfg, spec, { initialTask: "on fix" }, "0.1.0")).path;
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
  await git(["switch", "--quiet", "-c", "fix/action-summarizer-authz"], onFix);

  const json = await ccxLs("--branch", "*-authz", "--json");
  expect(json.code).toBe(0);
  const infos = JSON.parse(json.out) as { path: string; git: { branch: string | null } }[];
  expect(infos.map((i) => [i.path, i.git.branch])).toEqual([[onFix, "fix/action-summarizer-authz"]]);

  const table = await ccxLs("-b", "main");
  expect(table.code).toBe(0);
  const lines = table.out.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("test-owner/demo  main");
  expect(lines[0]).toContain("on main");

  const all = await ccxLs("--json");
  expect((JSON.parse(all.out) as { path: string }[]).map((i) => i.path).sort()).toEqual([onMain, onFix].sort());

  const none = await ccxLs("--branch", "nope");
  expect([none.code, none.out, none.err.trim()]).toEqual([0, "", "no repodirs"]);

  const empty = await ccxLs("--branch", "");
  expect([empty.code, empty.out, empty.err.trim()]).toEqual([1, "", "--branch needs a branch name or glob"]);
});
