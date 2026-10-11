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
    expect(await unpushedLanded(w)).toEqual({ landed: true, how: "every changed file's content is in origin/main's history" });
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

  test("with nothing to compare with, it says so instead of guessing", async () => {
    const w = await clone("no-ref");
    await git(["switch", "--quiet", "-c", "feat"], w);
    await commit(w, { "n.txt": "n\n" }, "n");
    await git(["remote", "remove", "origin"], w);
    expect(await unpushedLanded(w)).toEqual({ landed: false, how: "no remote branch to compare with", missing: [] });
  });
});
