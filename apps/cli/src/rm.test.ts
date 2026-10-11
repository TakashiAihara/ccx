/**
 * ccx rd rm を CLI として叩く。blockers を見て止まること、--force で本当に消えること (#116)、
 * 中にシェルがいる repodir を止めること (#221)、rd ls のパスでも指せること。
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRepodir, git, parseRepoSpec, type Config } from "@ccx/core";

const REMOTE = "https://github.com/test-owner/demo.git";
const cli = join(import.meta.dir, "index.ts");

let tmp: string;
let cfg: Config;
let gitconfig: string;
let savedGitConfig: string | undefined;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-rm-"));
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
  savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  cfg = {
    root: join(tmp, "repodirs"),
    mirrorRoot: join(tmp, "repodirs", ".mirror"),
    defaultHost: "github.com",
    machine: "test-machine",
    protocol: "https",
    mirrorMaxAgeMs: 600_000,
    defaults: { agent: "claude" },
  };
});

afterAll(async () => {
  if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
  await rm(tmp, { recursive: true, force: true });
});

async function ccxRm(...args: string[]) {
  const p = Bun.spawn(["bun", "run", cli, "rd", "rm", ...args], {
    env: { ...process.env, CCX_ROOT: cfg.root, GIT_CONFIG_GLOBAL: gitconfig, XDG_CONFIG_HOME: tmp, CCX_HUB_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

test.skipIf(process.platform !== "linux")("rd rm refuses a repodir a shell is still in; --force removes it for real; a path selects it (#116, #221)", async () => {
  const r = await createRepodir(cfg, parseRepoSpec("test-owner/demo", { defaultHost: "github.com" }), {}, "0.1.0");
  const shell = Bun.spawn(["sleep", "60"], { cwd: r.path });
  try {
    const refused = await ccxRm(r.path.split("/").at(-1)!);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`have their cwd in it: ${shell.pid} sleep`);
    expect(await exists(r.path)).toBe(true);

    // パスは repodir と一致するものだけ。dir-id で終わるだけの別のパスでは選ばない
    const wrong = await ccxRm(join(tmp, r.path.split("/").at(-1)!), "--force");
    expect([wrong.code, wrong.err]).toEqual([1, expect.stringContaining("no repodir matches")]);
    const root = await ccxRm("/", "--force");
    expect([root.code, root.err]).toEqual([1, expect.stringContaining("no repodir matches")]);
    expect(await exists(r.path)).toBe(true);

    const forced = await ccxRm(`${r.path}/`, "--force");
    expect([forced.code, forced.err]).toEqual([0, expect.stringContaining("(forced)")]);
    expect(await exists(r.path)).toBe(false);
  } finally {
    shell.kill();
    await shell.exited;
  }
});
