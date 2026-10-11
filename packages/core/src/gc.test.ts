/**
 * gc の安全弁。ここが間違うと作業が消える。
 *
 * 「終わった」と「消してよい」は別の軸であることを固定する。done マーカーは AI agent の
 * 宣言であって許可ではない。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { blockers, isSafeToRemove, plan, reclaim } from "./gc.ts";
import { git } from "./git.ts";
import { metaPath, statePath, writeState } from "./meta.ts";
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
    machine: "test-machine",
    protocol: "https",
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

  test("cwd が repodir の中にあるプロセスがあれば止める。隣の名前の dir は数えない (#221)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    const proc = await mkdtemp(join(tmp, "proc-"));
    const fake = async (pid: number, cwd: string, comm: string) => {
      await mkdir(join(proc, String(pid)), { recursive: true });
      await symlink(cwd, join(proc, String(pid), "cwd"));
      await Bun.write(join(proc, String(pid), "comm"), `${comm}\n`);
    };
    await fake(101, r.path, "zsh");
    await fake(102, join(r.path, "apps"), "vim");
    await fake(103, `${r.path}x`, "bash");
    await fake(104, tmp, "bash");
    await Bun.write(join(proc, "self"), "");

    const info = find(await scanRepodirs(cfg, { procRoot: proc }), r.path);
    expect(info.processes.sort((a, b) => a.pid - b.pid)).toEqual([{ pid: 101, command: "zsh" }, { pid: 102, command: "vim" }]);
    expect(blockers(info)).toContain("2 process(es) have their cwd in it: 101 zsh, 102 vim");
  });

  test("root が symlink を通っていても、実パスの cwd を数える (#221)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    const link = join(tmp, "root-link");
    await symlink(cfg.root, link);
    const proc = await mkdtemp(join(tmp, "proc-"));
    await mkdir(join(proc, "201"), { recursive: true });
    await symlink(r.path, join(proc, "201", "cwd"));
    await Bun.write(join(proc, "201", "comm"), "zsh\n");
    const viaLink = { ...cfg, root: link };
    const info = (await scanRepodirs(viaLink, { procRoot: proc })).find((i) => i.dirId === r.path.split("/").at(-1))!;
    expect(info.processes).toEqual([{ pid: 201, command: "zsh" }]);
  });

  test.skipIf(process.platform !== "linux")("本物の /proc: repodir の中で動くシェルを数える (#221)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    const p = Bun.spawn(["sleep", "60"], { cwd: r.path });
    try {
      const info = find(await scanRepodirs(cfg), r.path);
      expect(info.processes).toContainEqual({ pid: p.pid, command: "sleep" });
    } finally {
      p.kill();
      await p.exited;
    }
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

describe("壊れた metadata は回収を妨げない", () => {
  // 検証を足したことで「壊れた dir こそ消せない」罠が生まれると、issue #13 が防ごうと
  // した「正体不明のディレクトリが溜まる」状態を、逆に固定してしまう。gc の判断材料は
  // あくまで作業の有無 (blockers) であって、metadata が読めるかどうかではない。
  test("ccx.json が壊れていても、作業が無ければ回収できる", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(metaPath(r.path), '{ "schema": 1, "agent"');
    await rm(statePath(r.path));

    const info = find(await scanRepodirs(cfg), r.path);

    // 壊れていることは見えている。それでも回収は妨げない
    expect(info.meta).toBeNull();
    expect(info.state).toBeNull();
    expect(info.problems).not.toEqual([]);
    expect(blockers(info)).toEqual([]);

    const p = await plan([info], {});
    expect(p.remove).toHaveLength(1);

    const removed = await reclaim(p.remove);
    expect(removed).toEqual([r.path]);
    expect(await Bun.file(join(r.path, "README.md")).exists()).toBe(false);
  });

  test("metadata が壊れていても、作業を持っていれば守る", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(metaPath(r.path), "not json at all");
    await Bun.write(join(r.path, "precious.txt"), "do not lose me\n");

    const info = find(await scanRepodirs(cfg), r.path);
    expect(blockers(info)).toContain("the working tree is dirty");

    const p = await plan([info], {});
    expect(p.remove).toHaveLength(0);
    expect(await Bun.file(join(r.path, "precious.txt")).exists()).toBe(true);
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
