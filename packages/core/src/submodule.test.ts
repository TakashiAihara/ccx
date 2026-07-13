/**
 * submodule を持つ repo の repodir 生成。
 *
 * .gitmodules の URL を **相対** (../sub.git) にしてある。相対 URL は origin を基準に
 * 解決されるため、submodule を取る前に origin を実リモートへ付け替えていないと、mirror の
 * ローカル path を基準に解決してしまう。この順序を固定するためのテスト。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { git } from "./git.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";

const SUPER = "https://github.com/test-owner/demo.git";
const SUB = "https://github.com/test-owner/sub.git";

let tmp: string;
let cfg: Config;
let saved: string | undefined;

const spec = () => parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-sub-"));

  const subSrc = join(tmp, "sub.git");
  const superSrc = join(tmp, "demo.git");

  // submodule 本体
  const subWork = join(tmp, "sub-work");
  await git(["init", "--quiet", "--initial-branch", "main", subWork]);
  await git(["config", "user.email", "t@example.com"], subWork);
  await git(["config", "user.name", "t"], subWork);
  await Bun.write(join(subWork, "lib.txt"), "library\n");
  await git(["add", "lib.txt"], subWork);
  await git(["commit", "--quiet", "-m", "sub init"], subWork);
  await git(["clone", "--quiet", "--bare", subWork, subSrc]);

  // superproject。まず絶対 file:// で submodule を足し、.gitmodules を相対 URL に書き換える
  const superWork = join(tmp, "demo-work");
  await git(["init", "--quiet", "--initial-branch", "main", superWork]);
  await git(["config", "user.email", "t@example.com"], superWork);
  await git(["config", "user.name", "t"], superWork);
  await Bun.write(join(superWork, "README.md"), "# demo\n");
  await git(["add", "README.md"], superWork);
  await git(["commit", "--quiet", "-m", "init"], superWork);
  await git(
    ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", `file://${subSrc}`, "sub"],
    superWork,
  );
  await Bun.write(
    join(superWork, ".gitmodules"),
    '[submodule "sub"]\n\tpath = sub\n\turl = ../sub.git\n',
  );
  await git(["add", ".gitmodules", "sub"], superWork);
  await git(["commit", "--quiet", "-m", "add submodule"], superWork);
  await git(["clone", "--quiet", "--bare", superWork, superSrc]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], superSrc);

  // 実リモート URL をローカルの bare repo に読み替える。相対 URL の解決先
  // (https://github.com/test-owner/sub.git) にも対応させる。
  const gitconfig = join(tmp, "gitconfig");
  await Bun.write(
    gitconfig,
    [
      `[url "file://${superSrc}"]`,
      `\tinsteadOf = ${SUPER}`,
      `[url "file://${subSrc}"]`,
      `\tinsteadOf = ${SUB}`,
      `[protocol "file"]`,
      `\tallow = always`,
      "",
    ].join("\n"),
  );
  saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;

  cfg = {
    root: join(tmp, "repodirs"),
    mirrorRoot: join(tmp, "repodirs", ".mirror"),
    defaultHost: "github.com",
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

describe("submodules", () => {
  test("submodule の中身まで checkout される", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    expect(await Bun.file(join(r.path, "sub", "lib.txt")).text()).toBe("library\n");
  });

  test("submodule を取り込んでも working tree は clean のまま", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    expect(await git(["status", "--porcelain"], r.path)).toBe("");
  });

  test("相対 URL の submodule が実リモート基準で解決される (mirror 基準ではない)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    // 解決に使われた URL は submodule.<name>.url に残る。mirror の path が混ざっていたら
    // origin を直す前に submodule を取ってしまっている。
    const resolved = await git(["config", "--get", "submodule.sub.url"], r.path);
    expect(resolved).not.toContain(".mirror");
    expect(resolved).toContain("sub");
  });

  test("--no-recursive 相当を渡すと submodule を取らない", async () => {
    const r = await createRepodir(cfg, spec(), { recurseSubmodules: false }, "0.1.0");

    expect(await Bun.file(join(r.path, "sub", "lib.txt")).exists()).toBe(false);
  });
});
