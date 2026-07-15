/**
 * submodule を持つ repo の repodir 生成。
 *
 * .gitmodules の URL を **相対** (../sub.git) にしてある。相対 URL は origin を基準に
 * 解決されるため、submodule を取る前に origin を実リモートへ付け替えていないと、mirror の
 * ローカル path を基準に解決してしまう。この順序を固定するためのテスト。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { git } from "./git.ts";
import { mirrorPath } from "./mirror.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";

const SUPER = "https://github.com/test-owner/demo.git";
const SUB = "https://github.com/test-owner/sub.git";
const SSH_SUPER = "git@github.com:test-owner/demo.git";
const SSH_SUB = "git@github.com:test-owner/sub.git";

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
      `\tinsteadOf = ${SSH_SUPER}`,
      `[url "file://${subSrc}"]`,
      `\tinsteadOf = ${SUB}`,
      `\tinsteadOf = ${SSH_SUB}`,
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

  test("protocol = ssh でも、相対 URL の submodule が ssh の実リモート基準で解決される", async () => {
    // 相対 URL (../sub.git) は origin を基準に解決される。origin が scp-like (git@host:owner/repo)
    // のときに正しく解決できるかは、実際に通してみないと分からない (URL の文法が https と違う)。
    const c: Config = {
      ...cfg,
      root: join(tmp, "repodirs-ssh"),
      mirrorRoot: join(tmp, "mirror-ssh"),
      protocol: "ssh",
    };

    const r = await createRepodir(c, spec(), {}, "0.1.0");

    expect(await Bun.file(join(r.path, "sub", "lib.txt")).exists()).toBe(true);

    const resolved = await git(["config", "--get", "submodule.sub.url"], r.path);
    expect(resolved).toBe(SSH_SUB);
    expect(resolved).not.toContain(".mirror");
  });

  test("clone 後の submodule 取得が失敗しても、mirror が古い旨の警告は握り潰さない", async () => {
    // 警告を末尾で一括出力すると、その手前の submodule update / meta 書き込みが落ちたときに
    // 警告が一度も出ない。失敗をデバッグするユーザーが一番欲しい「mirror が stale/offline
    // だった」という文脈が剥ぎ取られる。警告は clone 成功直後に出すべき、を固定する。
    const c: Config = {
      ...cfg,
      root: join(tmp, "repodirs-warn"),
      mirrorRoot: join(tmp, "mirror-warn"),
      mirrorMaxAgeMs: 1,
    };

    // superproject の mirror を作る (submodule は取らない)
    await createRepodir(c, spec(), { recurseSubmodules: false }, "0.1.0");

    // mirror を stale にする。remote update は成功するが「古かった」経路を通したいので、
    // 最終 fetch 時刻を過去へずらして needsUpdate を強制する
    const old = new Date(Date.now() - 3 * 3_600_000);
    for (const f of ["FETCH_HEAD", "packed-refs", "HEAD"]) {
      await utimes(join(mirrorPath(c, spec()), f), old, old).catch(() => {});
    }

    // super も sub も到達不能にする (insteadOf の読み替えを全て外す)。すると:
    //   - ensureMirror の remote update が失敗 → stale=true、警告が生成される
    //   - mirror 実体はディスク上に健全なので、そこからの clone (superproject) は成功する
    //   - submodule update --init は ../sub.git を到達不能な https に解決して throw する
    // これが「clone は通ったが、その後のステップが落ちる」= 警告が握り潰される条件。
    const broken = join(tmp, "gitconfig-broken");
    await Bun.write(broken, '[protocol "file"]\n\tallow = always\n');
    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = broken;

    const said: string[] = [];
    try {
      const attempt = createRepodir(c, spec(), { warn: (m) => void said.push(m) }, "0.1.0");
      // submodule update が落ちるので reject する
      await expect(attempt).rejects.toThrow();
    } finally {
      process.env.GIT_CONFIG_GLOBAL = prev;
    }

    // それでも「mirror が古い」警告は出ている (握り潰されていない)
    expect(said.join("\n")).toContain("could not update the mirror");
  });

  test("--no-recursive 相当を渡すと submodule を取らない", async () => {
    const r = await createRepodir(cfg, spec(), { recurseSubmodules: false }, "0.1.0");

    expect(await Bun.file(join(r.path, "sub", "lib.txt")).exists()).toBe(false);
  });
});
