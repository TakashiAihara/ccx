/**
 * gc の安全弁。ここが間違うと作業が消える。
 *
 * 「終わった」と「消してよい」は別の軸であることを固定する。done マーカーは AI agent の
 * 宣言であって許可ではない。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { blockers, isSafeToRemove, plan, reclaim, scanTree, unsafePath, unsafeRoot } from "./gc.ts";
import { git } from "./git.ts";
import { writeState } from "./meta.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";
import { claudeProjectDir, scanRepodirs, type RepodirInfo } from "./scan.ts";

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

/**
 * 旧 clone (ccx 以前の連番 clone) の回収。
 *
 * これらは移行しない。session 履歴が cwd をキーに索引されているので、動かせば履歴が
 * 孤児になる。同じ安全弁の下で自然減させる — つまり ccx.json も dir-id も無い dir で
 * blockers が同じように効かなければならない。ここが緩むと、実測で dirty 3 件・
 * 未 push 4 件を抱えている 55 個の clone が飛ぶ。
 */
describe("foreign tree (ccx が作っていない clone)", () => {
  let legacy: string;
  const sessionDirs: string[] = [];

  const clone = async (name: string): Promise<string> => {
    const dest = join(legacy, "github.com", "test-owner", name);
    await git(["clone", "--quiet", REMOTE, dest]);
    // clone は insteadOf で書き換わった後の URL を記録する。本物の旧 clone が持って
    // いるのは書き換え前の URL なので、それに合わせる (fetch は insteadOf で通る)。
    await git(["remote", "set-url", "origin", REMOTE], dest);
    await git(["config", "user.email", "t@example.com"], dest);
    await git(["config", "user.name", "t"], dest);
    return dest;
  };

  const commit = async (dir: string, file: string) => {
    await Bun.write(join(dir, file), `${file}\n`);
    await git(["add", file], dir);
    await git(["commit", "--quiet", "-m", file], dir);
  };

  const scanOne = async (path: string) => {
    const infos = await scanTree(legacy, { defaultHost: "github.com" });
    return infos.find((i) => i.path === path)!;
  };

  beforeAll(() => {
    legacy = join(tmp, "legacy");
  });

  afterAll(async () => {
    for (const d of sessionDirs) await rm(d, { recursive: true, force: true });
  });

  test("ccx.json を持たない clean な clone は、そうと判ったうえで削除対象になる", async () => {
    const dir = await clone("clean");
    const info = await scanOne(dir);

    expect(info.foreign).toBe(true);
    expect(info.meta).toBeNull();
    expect(info.spec).toEqual({ host: "github.com", owner: "test-owner", repo: "demo" });
    expect(blockers(info)).toEqual([]);

    const p = await plan([info], {});
    expect(p.remove).toHaveLength(1);
  });

  test("working tree が dirty なら止める", async () => {
    const dir = await clone("dirty");
    await Bun.write(join(dir, "scratch.txt"), "unsaved\n");

    expect(blockers(await scanOne(dir))).toContain("the working tree is dirty");
  });

  test("未 push commit があれば止める", async () => {
    const dir = await clone("unpushed");
    await commit(dir, "work.txt");

    const info = await scanOne(dir);
    expect(info.git.unpushed).toBe(1);
    expect(blockers(info)).toContain("1 unpushed commit(s)");
  });

  test("checkout していないブランチの未 push commit も止める", async () => {
    // 旧 clone は何年ぶんものローカルブランチを抱えている。現在のブランチだけを見ると
    // 取り残された作業を見落とす。
    const dir = await clone("unpushed-other-branch");
    await git(["switch", "--quiet", "-c", "feature"], dir);
    await commit(dir, "feature.txt");
    await git(["switch", "--quiet", "main"], dir);

    const info = await scanOne(dir);
    expect(info.git.branch).toBe("main");
    expect(info.git.dirty).toBe(false);
    expect(blockers(info)).toContain("1 unpushed commit(s)");
  });

  test("stash があれば止める", async () => {
    const dir = await clone("stashed");
    await Bun.write(join(dir, "README.md"), "# changed\n");
    await git(["stash", "push", "--quiet"], dir);

    const info = await scanOne(dir);
    expect(info.git.stashes).toBe(1);
    expect(blockers(info)).toContain("1 stash(es)");
  });

  test("session が生きていれば止める", async () => {
    const dir = await clone("in-session");

    // 履歴は cwd をキーに索引される。旧 clone でも同じ場所を見る。
    const proj = claudeProjectDir(dir);
    sessionDirs.push(proj);
    await Bun.write(join(proj, "abc.jsonl"), '{"type":"user"}\n');

    expect(blockers(await scanOne(dir))).toContain("a session is active");
  });

  test("ignored ファイルがあれば止める (git status には出ない)", async () => {
    // clean で push 済みでも、.env のように git がどこにも持っていない実体は残りうる。
    // 消したら二度と戻らない。repodir は ccx が作った使い捨てなので該当しないが、
    // foreign dir は人間と他のツールが育てたものなので、ここを見ないと .env が飛ぶ。
    const dir = await clone("with-ignored");
    await Bun.write(join(dir, ".gitignore"), ".env\n");
    await git(["add", ".gitignore"], dir);
    await git(["commit", "--quiet", "-m", "ignore .env"], dir);
    // main は他の clone の起点なので触らない。commit がどこかの remote から到達
    // できれば「push 済み」になる。
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/with-ignored"], dir);
    await Bun.write(join(dir, ".env"), "SECRET=1\n");

    const info = await scanOne(dir);
    expect(info.git.dirty).toBe(false);
    expect(info.git.unpushed).toBe(0);
    expect(blockers(info)).toContain("1 ignored path(s) that git cannot restore (.env)");
  });

  test("ignored が無ければ、その guard は回収を妨げない", async () => {
    const dir = await clone("no-ignored");

    expect(blockers(await scanOne(dir))).toEqual([]);
  });

  test("捨ててよい ignored を名指しすれば回収できるが、名指ししていないものは残る", async () => {
    // 実測: 旧 clone 55 個のうち 50 個が .serena/ (ツールが再生成するキャッシュ) だけを
    // 抱えていた。素朴に「ignored があれば止める」では回収が成立しない。かといって
    // ccx が「キャッシュらしき名前」を推測して捨てるのは、推測で消すということ。
    // 捨ててよいものは人間が名指しする。
    const cache = await clone("cache-only");
    await Bun.write(join(cache, ".gitignore"), ".serena/\n.env\n");
    await git(["add", ".gitignore"], cache);
    await git(["commit", "--quiet", "-m", "ignore"], cache);
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/cache-only"], cache);
    await Bun.write(join(cache, ".serena", "cache.json"), "{}\n");

    const secret = await clone("cache-and-secret");
    await Bun.write(join(secret, ".gitignore"), ".serena/\n.env\n");
    await git(["add", ".gitignore"], secret);
    await git(["commit", "--quiet", "-m", "ignore"], secret);
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/cache-and-secret"], secret);
    await Bun.write(join(secret, ".serena", "cache.json"), "{}\n");
    await Bun.write(join(secret, ".env"), "SECRET=1\n");

    const infos = await scanTree(legacy, { allowIgnored: [".serena/"] });
    const one = (p: string) => infos.find((i) => i.path === p)!;

    expect(blockers(one(cache))).toEqual([]);
    expect(blockers(one(secret))).toContain(
      "1 ignored path(s) that git cannot restore (.env)",
    );
  });

  test("repodir は ignored を持っていても止まらない (ccx が作った使い捨て)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(join(r.path, ".gitignore"), "node_modules\n");
    await git(["config", "user.email", "t@example.com"], r.path);
    await git(["config", "user.name", "t"], r.path);
    await git(["add", ".gitignore"], r.path);
    await git(["commit", "--quiet", "-m", "ignore"], r.path);
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/ignored-test"], r.path);
    await git(["branch", "--quiet", "--set-upstream-to", "origin/ignored-test"], r.path);
    await Bun.write(join(r.path, "node_modules", "x.js"), "//\n");

    const info = find(await scanRepodirs(cfg), r.path);
    expect(blockers(info)).toEqual([]);
  });

  test("worktree が登録されていれば止める", async () => {
    const dir = await clone("with-worktree");
    await git(["worktree", "add", "--quiet", "--detach", join(tmp, "wt")], dir);

    expect(blockers(await scanOne(dir))).toContain("1 registered worktree(s)");
  });

  test("remote を持たない clone は、push 済みか判らないので止める", async () => {
    const dir = await clone("no-remote");
    await git(["remote", "remove", "origin"], dir);

    const info = await scanOne(dir);
    // どのリモートからも到達できない commit = 全 commit
    expect(info.git.unpushed).toBeGreaterThan(0);
    expect(blockers(info)).toContain("1 unpushed commit(s)");
  });

  test("repo の中には潜らない (submodule を別の回収対象にしない)", async () => {
    const outer = await clone("outer");
    const nested = join(outer, "vendor", "nested");
    await git(["init", "--quiet", nested]);

    const paths = (await scanTree(legacy)).map((i) => i.path);
    expect(paths).toContain(outer);
    expect(paths).not.toContain(nested);
  });

  test("git repo でない dir は対象にしない", async () => {
    const notARepo = join(legacy, "github.com", "test-owner", "just-a-dir");
    await Bun.write(join(notARepo, "notes.md"), "hello\n");

    const paths = (await scanTree(legacy)).map((i) => i.path);
    expect(paths).not.toContain(notARepo);
  });

  test("reclaim は clean な clone だけを消し、作業を持つものは残す", async () => {
    const safe = await clone("reclaim-safe");
    const risky = await clone("reclaim-risky");
    await commit(risky, "precious.txt");

    const infos = (await scanTree(legacy)).filter(
      (i) => i.path === safe || i.path === risky,
    );
    const p = await plan(infos, {});

    expect(p.remove.map((c) => c.info.path)).toEqual([safe]);
    expect(p.keep.map((c) => c.info.path)).toEqual([risky]);

    const removed = await reclaim(p.remove);

    expect(removed).toEqual([safe]);
    expect(await Bun.file(join(safe, "README.md")).exists()).toBe(false);
    expect(await Bun.file(join(risky, "precious.txt")).exists()).toBe(true);
  });
});

describe("path そのものが危険なら消さない", () => {
  test("浅すぎる path / home / ルートを拒む", () => {
    expect(unsafePath("/")).toBeTruthy();
    expect(unsafePath(process.env.HOME!)).toBeTruthy();
    expect(unsafePath("/tmp")).toBeTruthy();
    expect(unsafePath("/a/b/c")).toBeNull();
  });

  test("走査 root は / と home を拒み、それ以外は通す", () => {
    // root は消さないので、rm 対象より判定は緩い。~/.ghq のような 2 階層は通す。
    expect(unsafeRoot("/")).toBeTruthy();
    expect(unsafeRoot(homedir())).toBeTruthy();
    expect(unsafeRoot(join(homedir(), ".ghq"))).toBeNull();
  });

  test("blockers は危険な path を blocker として返す", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    const info = find(await scanRepodirs(cfg), r.path);

    expect(blockers({ ...info, path: "/tmp" })).toContain(
      "path is too shallow to be a repository (/tmp)",
    );
  });
});
