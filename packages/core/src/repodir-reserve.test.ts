/**
 * dir-id の取り合い: 既にあるディレクトリには入らず、消しもしない (#235)。
 * newDirId を決まった列に差し替えるため、repodir.test.ts とは別のファイルにしている。
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import * as dirid from "./dirid.ts";
import { git } from "./git.ts";
import { parseRepoSpec } from "./repospec.ts";

let ids: string[] = [];
mock.module("./dirid.ts", () => ({ ...dirid, newDirId: () => ids.shift() ?? "ZZZZZZZZZZZZZZ" }));
const { createRepodir } = await import("./repodir.ts");

let tmp: string;
let cfg: Config;
let savedGitConfig: string | undefined;
const spec = () => parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-reserve-"));
  const work = join(tmp, "work");
  const source = join(tmp, "source.git");
  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["clone", "--quiet", "--bare", work, source]);
  const gitconfig = join(tmp, "gitconfig");
  await Bun.write(gitconfig, `[url "file://${source}"]\n\tinsteadOf = https://github.com/test-owner/demo.git\n`);
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

test("a dir-id whose directory already exists is skipped, and that directory is left alone", async () => {
  const parent = join(cfg.root, "github.com", "test-owner", "demo");
  await mkdir(join(parent, "AAAAAAAAAAAAAA"), { recursive: true });
  await Bun.write(join(parent, "AAAAAAAAAAAAAA", "someone-else.txt"), "x");

  ids = ["AAAAAAAAAAAAAA", "BBBBBBBBBBBBBB"];
  const r = await createRepodir(cfg, spec(), {}, "0.1.0");
  expect(r.dirId).toBe("BBBBBBBBBBBBBB");
  expect(await readdir(join(parent, "AAAAAAAAAAAAAA"))).toEqual(["someone-else.txt"]);
});

test("when every dir-id it tries is taken, it gives up with EEXIST and removes nothing", async () => {
  const parent = join(cfg.root, "github.com", "test-owner", "demo");
  ids = Array(10).fill("AAAAAAAAAAAAAA");
  await expect(createRepodir(cfg, spec(), {}, "0.1.0")).rejects.toThrow(/EEXIST/);
  expect(await readdir(join(parent, "AAAAAAAAAAAAAA"))).toEqual(["someone-else.txt"]);
  // 6 回で諦める (残りは使われていない)
  expect(ids.length).toBe(4);
});
