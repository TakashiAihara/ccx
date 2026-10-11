import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "./git.ts";
import { unpushedLanded } from "./landed.ts";

let tmp: string;
let remote: string;
let other: string;

async function clone(name: string): Promise<string> {
  const dir = join(tmp, name);
  await git(["clone", "--quiet", remote, dir]);
  await git(["config", "user.email", "t@example.com"], dir);
  await git(["config", "user.name", "t"], dir);
  return dir;
}

async function commit(dir: string, files: Record<string, string | null>, msg: string): Promise<void> {
  for (const [f, body] of Object.entries(files)) {
    if (body === null) await git(["rm", "--quiet", f], dir);
    else {
      await Bun.write(join(dir, f), body);
      await git(["add", f], dir);
    }
  }
  await git(["commit", "--quiet", "-m", msg], dir);
}

/** 別の clone から main に入れて push する (squash merge の代わり) */
async function landOnMain(files: Record<string, string | null>): Promise<void> {
  await git(["pull", "--quiet", "--ff-only"], other);
  await commit(other, files, "landed");
  await git(["push", "--quiet", "origin", "main"], other);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-landed-"));
  remote = join(tmp, "remote.git");
  await git(["init", "--quiet", "--bare", "--initial-branch", "main", remote]);
  const seed = await clone("seed");
  await commit(seed, { "a.txt": "a\n", "gone.txt": "g\n" }, "init");
  await git(["push", "--quiet", "origin", "main"], seed);
  other = await clone("other");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("unpushedLanded (#220)", () => {
  test("a remote ref at HEAD is landed", async () => {
    const w = await clone("at-head");
    expect(await unpushedLanded(w)).toEqual({ landed: true, how: "origin/main is at HEAD" });
  });

  test("a commit whose patch is on main (cherry-picked / rebased) is landed", async () => {
    const w = await clone("cherry");
    await git(["switch", "--quiet", "-c", "feat"], w);
    await commit(w, { "c.txt": "c\n" }, "add c");
    await landOnMain({ "c.txt": "c\n" });
    await git(["fetch", "--quiet"], w);
    expect(await unpushedLanded(w)).toEqual({ landed: true, how: "every commit's patch is in origin/main" });
  });

  test("commits squashed into one on main are landed by their files' content", async () => {
    const w = await clone("squash");
    await git(["switch", "--quiet", "-c", "feat"], w);
    await commit(w, { "s.txt": "one\n" }, "first");
    await commit(w, { "s.txt": "one\ntwo\n", "gone.txt": null }, "second");
    await landOnMain({ "s.txt": "one\ntwo\n", "gone.txt": null });
    await git(["fetch", "--quiet"], w);
    expect(await unpushedLanded(w)).toEqual({ landed: true, how: "every changed file's content reached origin/main after the branch point" });
  });

  test("a commit added after the squash, never pushed, is not landed and its files are named", async () => {
    const w = await clone("late");
    await git(["switch", "--quiet", "-c", "feat"], w);
    await commit(w, { "l.txt": "l\n" }, "landed part");
    await landOnMain({ "l.txt": "l\n" });
    await commit(w, { "l.txt": "l\nlate\n", "a.txt": null }, "late part");
    await git(["fetch", "--quiet"], w);
    const r = await unpushedLanded(w);
    expect(r.landed).toBe(false);
    // a.txt はまだ main にあるので、手元で消したことは入っていない
    expect(r.landed ? [] : [...r.missing].sort()).toEqual(["a.txt", "l.txt"]);
  });

  test("content that landed after the repodir last fetched is found in the mirror (#220)", async () => {
    const w = await clone("stale");
    await git(["switch", "--quiet", "-c", "feat"], w);
    await commit(w, { "m.txt": "mirror one\n" }, "first");
    await commit(w, { "m.txt": "mirror one\nmirror two\n" }, "second");
    await landOnMain({ "m.txt": "mirror one\nmirror two\n" });
    // mirror が分岐点を持っていなければ mirror は見ない (判定できないで止めない)
    const empty = join(tmp, "empty-mirror.git");
    await git(["init", "--quiet", "--bare", "--initial-branch", "main", empty]);
    expect((await unpushedLanded(w, { mirror: { path: empty, branch: "main" } })).landed).toBe(false);
    // repodir の origin/main は古いまま: それだけでは入っていないと見える
    expect((await unpushedLanded(w)).landed).toBe(false);
    expect(await unpushedLanded(w, { mirror: { path: remote, branch: "main" } })).toEqual({
      landed: true,
      how: "every changed file's content reached the mirror's main after the branch point",
    });
  });

  test("content that only looks upstream is not landed: an old version, a rename, an empty or copied file, a non-ASCII name, another branch", async () => {
    // main に v1 → v2 と入っている old.txt
    await landOnMain({ "old.txt": "v1\n" });
    await landOnMain({ "old.txt": "v2\n" });
    const check = async (name: string, files: Record<string, string | null>, after?: (w: string) => Promise<void>) => {
      const w = await clone(name);
      await git(["config", "core.quotePath", "true"], w);
      await git(["switch", "--quiet", "-c", "feat"], w);
      if (after) await after(w);
      else await commit(w, files, name);
      return unpushedLanded(w);
    };
    // 古い版へ戻す
    expect((await check("revert", { "old.txt": "v1\n" })).landed).toBe(false);
    // 空のファイル / 他のファイルの写し (同じ中身は main の別のパスにある)
    expect((await check("empty", { "e.txt": "" })).landed).toBe(false);
    expect((await check("copy", { "copy.txt": "v2\n" })).landed).toBe(false);
    // 日本語のファイル名 (core.quotePath で引用符付きになる)
    expect((await check("ja", { "メモ.md": "v2\n" })).landed).toBe(false);
    // 改名 (main には元の名前しかない)
    expect(
      (
        await check("rename", {}, async (w) => {
          await git(["mv", "old.txt", "moved.txt"], w);
          await git(["commit", "--quiet", "-m", "rename"], w);
        })
      ).landed,
    ).toBe(false);
    // 別の remote ブランチに push しただけ
    expect(
      (
        await check("wip", {}, async (w) => {
          await commit(w, { "w.txt": "wip\n" }, "wip");
          await git(["push", "--quiet", "origin", "HEAD:refs/heads/wip"], w);
        })
      ).landed,
    ).toBe(false);
  });

  test("after the branch point: the same content under another path, or a rename whose old path is still upstream, is not landed", async () => {
    // 他のパスに同じ中身が分岐点の後で入った
    const copy = await clone("copy-after");
    await git(["switch", "--quiet", "-c", "feat"], copy);
    await landOnMain({ "src.txt": "shared after the branch\n" });
    await git(["fetch", "--quiet"], copy);
    await commit(copy, { "dst.txt": "shared after the branch\n" }, "copy");
    expect(await unpushedLanded(copy)).toEqual({ landed: false, how: "not in origin/main", missing: ["dst.txt"] });

    // 改名: main には新しい名前も入ったが、元の名前も残っている
    const ren = await clone("rename-after");
    await git(["switch", "--quiet", "-c", "feat"], ren);
    await landOnMain({ "keep.txt": "kept\n" });
    await git(["pull", "--quiet", "--rebase", "origin", "main"], ren);
    await landOnMain({ "moved.txt": "kept\n" });
    await git(["fetch", "--quiet"], ren);
    await git(["mv", "keep.txt", "moved.txt"], ren);
    await git(["commit", "--quiet", "-m", "rename"], ren);
    const r = await unpushedLanded(ren);
    expect(r.landed ? [] : r.missing).toEqual(["keep.txt"]);
  });

  test("each compared ref uses its own branch point; a merge carrying its own change is not landed; no change says so", async () => {
    // develop: d0 → d1 → 分岐。起点ブランチ develop で、分岐点より前の d0 に戻すのは入っていない
    // (main の分岐点で develop を見ると、d0 が develop の履歴にあるので入っているに見える)
    await git(["pull", "--quiet", "--ff-only"], other);
    await git(["switch", "--quiet", "-c", "develop"], other);
    await commit(other, { "dev.txt": "d0\n" }, "d0");
    await commit(other, { "dev.txt": "d1\n" }, "d1");
    await git(["push", "--quiet", "origin", "develop"], other);
    await git(["switch", "--quiet", "main"], other);
    const d = await clone("develop-base");
    await git(["switch", "--quiet", "-c", "feat", "origin/develop"], d);
    await commit(d, { "dev.txt": "d0\n" }, "back to d0");
    expect((await unpushedLanded(d, { baseBranch: "develop" })).landed).toBe(false);

    // develop にだけある変更 (main の a.txt を devA に) を、develop から切ったブランチで main の版に戻す。
    // main の分岐点で比べると「変化なし」に見える
    await git(["switch", "--quiet", "develop"], other);
    await git(["pull", "--quiet", "--ff-only", "origin", "develop"], other);
    await commit(other, { "a.txt": "devA\n" }, "devA");
    await git(["push", "--quiet", "origin", "develop"], other);
    await git(["switch", "--quiet", "main"], other);
    const u = await clone("undo-develop");
    await git(["switch", "--quiet", "-c", "feat", "origin/develop"], u);
    await commit(u, { "a.txt": "a\n" }, "undo devA");
    for (const mirror of [undefined, { path: remote, branch: "main" }]) {
      expect((await unpushedLanded(u, { baseBranch: "develop", mirror })).landed).toBe(false);
    }

    // merge が独自の変更を持つ (evil merge)
    const m = await clone("evil-merge");
    await git(["switch", "--quiet", "-c", "side"], m);
    await commit(m, { "side.txt": "side\n" }, "side");
    await landOnMain({ "side.txt": "side\n" });
    await git(["switch", "--quiet", "-c", "feat", "origin/main"], m);
    await git(["merge", "--quiet", "--no-ff", "--no-commit", "side"], m);
    await Bun.write(join(m, "evil.txt"), "only in the merge\n");
    await git(["add", "evil.txt"], m);
    await git(["commit", "--quiet", "-m", "merge side"], m);
    await git(["fetch", "--quiet"], m);
    const r = await unpushedLanded(m);
    expect([r.landed, r.landed ? [] : r.missing]).toEqual([false, ["evil.txt"]]);

    // 中身の変わらない commit だけ
    const e = await clone("no-change");
    await git(["switch", "--quiet", "-c", "feat"], e);
    await git(["commit", "--quiet", "--allow-empty", "-m", "empty"], e);
    expect(await unpushedLanded(e)).toEqual({ landed: true, how: "the files are the same as at the branch point on origin/main" });
  });

  test("with nothing to compare with, it says so instead of guessing", async () => {
    const w = await clone("no-ref");
    await git(["switch", "--quiet", "-c", "feat"], w);
    await commit(w, { "n.txt": "n\n" }, "n");
    await git(["remote", "remove", "origin"], w);
    expect(await unpushedLanded(w)).toEqual({ landed: false, how: "no remote branch to compare with", missing: [] });
  });
});

// 起点ブランチが develop のとき (#220 の 4 周目のレビュー)。順序に依らないよう remote ごと分ける
describe("unpushedLanded with a develop base", () => {
  let dev: string;
  let up: string;
  const cloneDev = async (name: string) => {
    const dir = join(tmp, `dev-${name}`);
    await git(["clone", "--quiet", dev, dir]);
    await git(["config", "user.email", "t@example.com"], dir);
    await git(["config", "user.name", "t"], dir);
    await git(["switch", "--quiet", "-c", "feat", "origin/develop"], dir);
    return dir;
  };
  const push = async (branch: string, files: Record<string, string | null>) => {
    await git(["switch", "--quiet", branch], up);
    await git(["pull", "--quiet", "--ff-only", "origin", branch], up);
    await commit(up, files, `${branch} change`);
    await git(["push", "--quiet", "origin", branch], up);
  };
  const check = async (w: string) => [
    (await unpushedLanded(w, { baseBranch: "develop" })).landed,
    (await unpushedLanded(w, { baseBranch: "develop", mirror: { path: dev, branch: "main" } })).landed,
  ];

  beforeAll(async () => {
    dev = join(tmp, "dev-remote.git");
    await git(["init", "--quiet", "--bare", "--initial-branch", "main", dev]);
    up = join(tmp, "dev-up");
    await git(["clone", "--quiet", dev, up]);
    await git(["config", "user.email", "t@example.com"], up);
    await git(["config", "user.name", "t"], up);
    await commit(up, { "a.txt": "a\n", "b.txt": "b\n" }, "init");
    await git(["push", "--quiet", "origin", "main"], up);
    await git(["switch", "--quiet", "-c", "develop"], up);
    await commit(up, { "a.txt": "devA\n", "only-dev.txt": "dev\n" }, "develop only");
    await git(["push", "--quiet", "origin", "develop"], up);
    // develop を切った後の main: hotfix と、a.txt を一度変えて戻す
    await push("main", { "b.txt": "hotfix\n" });
    await push("main", { "a.txt": "m1\n" });
    await push("main", { "a.txt": "a\n" });
  });

  test("a backport of a main hotfix is not in develop", async () => {
    const w = await cloneDev("backport");
    await commit(w, { "b.txt": "hotfix\n" }, "backport");
    expect(await check(w)).toEqual([false, false]);
  });

  test("undoing a develop-only change is not in develop, even if main once had that content", async () => {
    const w = await cloneDev("undo");
    await commit(w, { "a.txt": "a\n" }, "undo devA");
    expect(await check(w)).toEqual([false, false]);
  });

  test("deleting a develop-only file is not in develop, though main never had it", async () => {
    const w = await cloneDev("delete");
    await commit(w, { "only-dev.txt": null }, "drop it");
    expect(await check(w)).toEqual([false, false]);
  });

  test("the mirror is looked at on the base branch, and not at all on a branch without the branch point", async () => {
    // repodir は fetch していない: develop に入ったことは mirror の develop でしか見えない
    const w = await cloneDev("mirror-develop");
    await commit(w, { "d.txt": "d1\n" }, "d1");
    await commit(w, { "d.txt": "d1\nd2\n" }, "d2");
    await push("develop", { "d.txt": "d1\nd2\n" });
    expect(await check(w)).toEqual([false, true]);

    // develop を持たない mirror: 分岐点を含まない main とは比べない (main には hotfix がある)
    const mainOnly = join(tmp, "dev-main-only.git");
    await git(["clone", "--quiet", "--bare", "--single-branch", "--branch", "main", dev, mainOnly]);
    const b = await cloneDev("backport-main-mirror");
    await commit(b, { "b.txt": "hotfix\n" }, "backport");
    expect((await unpushedLanded(b, { baseBranch: "develop", mirror: { path: mainOnly, branch: "main" } })).landed).toBe(false);
  });

  test("work squashed into develop is landed (control)", async () => {
    const w = await cloneDev("landed");
    await commit(w, { "c.txt": "c1\n" }, "c1");
    await commit(w, { "c.txt": "c1\nc2\n" }, "c2");
    await push("develop", { "c.txt": "c1\nc2\n" });
    await git(["fetch", "--quiet"], w);
    expect(await check(w)).toEqual([true, true]);
  });
});
