/**
 * gc の安全弁。ここが間違うと作業が消える。
 *
 * 「終わった」と「消してよい」は別の軸であることを固定する。done マーカーは AI agent の
 * 宣言であって許可ではない。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { blockers, isSafeToRemove, plan, reclaim } from "./gc.ts";
import { git } from "./git.ts";
import { writeState } from "./meta.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";
import { scanRepodirs, type RepodirInfo } from "./scan.ts";

const REMOTE = "https://github.com/test-owner/demo.git";

let tmp: string;
let cfg: Config;
let saved: string | undefined;

const spec = () => parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });
const find = (infos: RepodirInfo[], path: string) => infos.find((i) => i.path === path)!;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-gc-"));
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
  saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;

  cfg = {
    root: join(tmp, "repodirs"),
    mirrorRoot: join(tmp, "repodirs", ".mirror"),
    defaultHost: "github.com",
    mirrorMaxAgeMs: 600_000,
    defaults: { agent: "claude" },
  };
});

afterAll(async () => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
  await rm(tmp, { recursive: true, force: true });
});

describe("blockers", () => {
  test("何も持っていない repodir は削除して安全", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    const info = find(await scanRepodirs(cfg), r.path);

    expect(blockers(info)).toEqual([]);
    expect(isSafeToRemove(info)).toBe(true);
  });

  test("working tree が dirty なら止める", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(join(r.path, "scratch.txt"), "unsaved\n");

    const info = find(await scanRepodirs(cfg), r.path);
    expect(blockers(info)).toContain("the working tree is dirty");
  });

  test("未 push commit があれば止める", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await git(["config", "user.email", "t@example.com"], r.path);
    await git(["config", "user.name", "t"], r.path);
    await Bun.write(join(r.path, "new.txt"), "work\n");
    await git(["add", "new.txt"], r.path);
    await git(["commit", "--quiet", "-m", "unpushed work"], r.path);

    const info = find(await scanRepodirs(cfg), r.path);
    expect(info.git.unpushed).toBe(1);
    expect(blockers(info)).toContain("1 unpushed commit(s)");
  });

  test("stash があれば止める", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await git(["config", "user.email", "t@example.com"], r.path);
    await git(["config", "user.name", "t"], r.path);
    await Bun.write(join(r.path, "README.md"), "# changed\n");
    await git(["stash", "push", "--quiet"], r.path);

    const info = find(await scanRepodirs(cfg), r.path);
    expect(info.git.stashes).toBe(1);
    expect(blockers(info)).toContain("1 stash(es)");
  });
});

describe("done マーカーは許可ではない", () => {
  test("done でも未 push commit があれば削除されない", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await git(["config", "user.email", "t@example.com"], r.path);
    await git(["config", "user.name", "t"], r.path);
    await Bun.write(join(r.path, "precious.txt"), "do not lose me\n");
    await git(["add", "precious.txt"], r.path);
    await git(["commit", "--quiet", "-m", "unpushed"], r.path);

    // AI agent が「終わった」と宣言した
    await writeState(r.path, {
      desired: "stopped",
      done: { at: new Date().toISOString(), by: "session:abc" },
    });

    const infos = await scanRepodirs(cfg);
    const p = await plan(infos.filter((i) => i.path === r.path), { finishedOnly: true });

    expect(p.remove).toHaveLength(0);
    expect(p.keep[0]!.blockers).toContain("1 unpushed commit(s)");
    expect(await Bun.file(join(r.path, "precious.txt")).exists()).toBe(true);
  });

  test("done かつ何も持っていなければ削除対象になる", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await writeState(r.path, {
      desired: "stopped",
      done: { at: new Date().toISOString(), by: "session:abc" },
    });

    const infos = await scanRepodirs(cfg);
    const p = await plan(infos.filter((i) => i.path === r.path), { finishedOnly: true });

    expect(p.remove).toHaveLength(1);
    expect(p.remove[0]!.finished).toBe("marked done by session:abc");
  });

  test("--finished-only では、終わっていない clean な repodir を残す", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    const infos = await scanRepodirs(cfg);
    const p = await plan(infos.filter((i) => i.path === r.path), { finishedOnly: true });

    expect(p.remove).toHaveLength(0);
    expect(p.keep[0]!.blockers).toContain("not finished");
  });
});

describe("plan と reclaim", () => {
  test("minAge より新しいものは残す", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    const infos = await scanRepodirs(cfg);
    const p = await plan(infos.filter((i) => i.path === r.path), { minAgeMs: 60_000 });

    expect(p.remove).toHaveLength(0);
    expect(p.keep[0]!.blockers).toContain("younger than the minimum age");
  });

  test("reclaim は blockers を再評価し、危険なものは消さない", async () => {
    const safe = await createRepodir(cfg, spec(), {}, "0.1.0");
    const risky = await createRepodir(cfg, spec(), {}, "0.1.0");

    const infos = await scanRepodirs(cfg);
    const p = await plan(
      infos.filter((i) => i.path === safe.path || i.path === risky.path),
      {},
    );
    expect(p.remove).toHaveLength(2);

    // plan を作った「後」に危険な状態になった
    await Bun.write(join(risky.path, "late.txt"), "appeared after planning\n");
    const fresh = await scanRepodirs(cfg);
    const candidates = p.remove.map((c) => ({
      ...c,
      info: find(fresh, c.info.path),
    }));

    const removed = await reclaim(candidates);

    expect(removed).toEqual([safe.path]);
    expect(await Bun.file(join(risky.path, "late.txt")).exists()).toBe(true);
    expect(await Bun.file(join(safe.path, "README.md")).exists()).toBe(false);
  });
});
