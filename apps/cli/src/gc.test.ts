/**
 * gc の CLI 経路。
 *
 * core を直接呼ぶテストでは、CLI にしか無い配線 (--root が名指しを要求する / unsafeRoot
 * の preflight / dry-run が既定である / ignored の集計出力) を 1 行も通らない。ここは
 * 実際に ccx を spawn して、コマンドとして安全弁が効いていることを固定する。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "@ccx/core";

const CLI = join(import.meta.dir, "index.ts");
const REMOTE = "https://github.com/test-owner/demo.git";

let tmp: string;
let legacy: string;
let env: Record<string, string>;
let savedGitConfig: string | undefined;

type Run = { stdout: string; stderr: string; code: number };

async function ccx(...args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function clone(name: string, origin = REMOTE): Promise<string> {
  const dest = join(legacy, "github.com", "test-owner", name);
  await git(["clone", "--quiet", REMOTE, dest]);
  await git(["remote", "set-url", "origin", origin], dest);
  return dest;
}

const exists = (path: string) => Bun.file(join(path, "README.md")).exists();

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-cli-gc-"));
  legacy = join(tmp, "legacy");

  const source = join(tmp, "source.git");
  const work = join(tmp, "work");
  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["clone", "--quiet", "--bare", work, source]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], source);

  const gitconfig = join(tmp, "gitconfig");
  await Bun.write(gitconfig, `[url "file://${source}"]\n\tinsteadOf = ${REMOTE}\n`);

  // テスト側で clone するときも、spawn した CLI と同じ書き換えが要る
  savedGitConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;

  env = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: gitconfig,
    // 実際の repodir root を触らせない
    CCX_ROOT: join(tmp, "repodirs"),
  };
});

afterAll(async () => {
  if (savedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfig;
  await rm(tmp, { recursive: true, force: true });
});

describe("ccx repodir gc --root", () => {
  test("名指しが無ければ実行を拒む", async () => {
    const r = await ccx("repodir", "gc", "--root", legacy);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--root requires --repo or --match");
  });

  test("home を指す symlink を渡しても、実体で気づいて拒む", async () => {
    const link = join(tmp, "looks-harmless");
    await symlink(homedir(), link);

    const r = await ccx("repodir", "gc", "--root", link, "--repo", "test-owner/demo");

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("refusing to scan the home directory");
  });

  test("--yes を渡さない限り、何も消えない", async () => {
    const dir = await clone("dry-run");

    const r = await ccx("repodir", "gc", "--root", legacy, "--repo", "test-owner/demo");

    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Nothing was deleted");
    expect(await exists(dir)).toBe(true);
  });

  test("--repo は部分一致しない。demo を名指ししても demo-notes は候補に出ない", async () => {
    const notes = await clone("demo-notes", "https://github.com/test-owner/demo-notes.git");

    const r = await ccx(
      "repodir", "gc", "--root", legacy, "--repo", "test-owner/demo", "--json",
    );
    const plan = JSON.parse(r.stdout) as {
      remove: { info: { path: string } }[];
      keep: { info: { path: string } }[];
    };

    const seen = [...plan.remove, ...plan.keep].map((c) => c.info.path);
    expect(seen).not.toContain(notes);
  });

  test("ignored で止まったとき、何を名指しすればよいかを出す", async () => {
    const dir = await clone("has-ignored");
    await Bun.write(join(dir, ".gitignore"), ".env\n");
    await git(["add", ".gitignore"], dir);
    await git(["config", "user.email", "t@example.com"], dir);
    await git(["config", "user.name", "t"], dir);
    await git(["commit", "--quiet", "-m", "ignore .env"], dir);
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/has-ignored"], dir);
    await Bun.write(join(dir, ".env"), "SECRET=1\n");

    const r = await ccx(
      "repodir", "gc", "--root", legacy, "--match", "*/*/has-ignored",
    );

    expect(r.stderr).toContain("ignored path(s) that git cannot restore (.env)");
    expect(r.stderr).toContain("1  .env");
    expect(r.stderr).toContain("--allow-ignored");
    expect(await exists(dir)).toBe(true);
  });

  test("--yes は clean なものだけを消し、作業を持つものは残す", async () => {
    const safe = await clone("yes-safe");
    const risky = await clone("yes-risky");
    await Bun.write(join(risky, "scratch.txt"), "unsaved\n");

    const r = await ccx(
      "repodir", "gc", "--root", legacy, "--match", "*/*/yes-{safe,risky}", "--yes",
    );

    expect(r.code).toBe(0);
    expect(await exists(safe)).toBe(false);
    expect(await exists(risky)).toBe(true);
    expect(await Bun.file(join(risky, "scratch.txt")).exists()).toBe(true);
  });
});
