/**
 * createRepodir の統合テスト。
 *
 * ネットワークに出ずに本番コードパスを通すため、git の insteadOf でリモート URL を
 * ローカルの bare repo に書き換える (GIT_CONFIG_GLOBAL)。cloneUrl() やその後の
 * remote set-url は production の実装がそのまま走る。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { DIR_ID_LENGTH, isDirId } from "./dirid.ts";
import { git } from "./git.ts";
import { readMeta, readState } from "./meta.ts";
import { mirrorPath } from "./mirror.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";

const REMOTE = "https://github.com/test-owner/demo.git";
const SSH_REMOTE = "git@github.com:test-owner/demo.git";

let tmp: string;
let source: string;
let cfg: Config;
let originalGitConfigGlobal: string | undefined;

const spec = () => parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-test-"));
  source = join(tmp, "source.git");

  // main と develop を持つ bare repo を作る
  const work = join(tmp, "work");
  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["switch", "--quiet", "-c", "develop"], work);
  await Bun.write(join(work, "dev.md"), "dev\n");
  await git(["add", "dev.md"], work);
  await git(["commit", "--quiet", "-m", "dev"], work);
  await git(["switch", "--quiet", "main"], work);
  await git(["clone", "--quiet", "--bare", work, source]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], source);

  // https / ssh どちらの URL も local bare repo に読み替えさせる。ssh の口を塞がずに
  // 「protocol を切り替えると clone URL と origin が両方 ssh になる」ことを検証するため。
  const gitconfig = join(tmp, "gitconfig");
  await Bun.write(
    gitconfig,
    `[url "file://${source}"]\n\tinsteadOf = ${REMOTE}\n\tinsteadOf = ${SSH_REMOTE}\n`,
  );
  originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
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
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  await rm(tmp, { recursive: true, force: true });
});

describe("createRepodir", () => {
  test("mirror を作り、path 構造 <host>/<owner>/<repo>/<dir-id> に repodir を生やす", async () => {
    const r = await createRepodir(cfg, spec(), { initialTask: "調べる" }, "0.1.0");

    expect(r.mirror.created).toBe(true);
    expect(isDirId(r.dirId)).toBe(true);
    expect(r.dirId).toHaveLength(DIR_ID_LENGTH);
    expect(r.path).toBe(join(cfg.root, "github.com", "test-owner", "demo", r.dirId));
    expect(await Bun.file(join(r.path, "README.md")).exists()).toBe(true);
  });

  test("origin を実リモートに付け替える (忘れると push が mirror に飛ぶ)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    // get-url は insteadOf の書き換えを適用して返すため、保存値そのものを見る
    const stored = await git(["config", "--get", "remote.origin.url"], r.path);
    expect(stored).toBe(REMOTE);
    expect(stored).not.toContain(".mirror");
  });

  test("mirror と repodir が pack を hardlink 共有する (.git の実消費が実質ゼロ)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");

    const packDir = (p: string) => join(p, "objects", "pack");
    const packOf = async (dir: string) => {
      const glob = new Bun.Glob("*.pack");
      const files = [...glob.scanSync({ cwd: dir, absolute: true })];
      expect(files.length).toBeGreaterThan(0);
      return files[0]!;
    };

    const mirrorPack = await packOf(packDir(mirrorPath(cfg, spec())));
    const repodirPack = await packOf(packDir(join(r.path, ".git")));

    const [a, b] = await Promise.all([stat(mirrorPack), stat(repodirPack)]);
    expect(b.ino).toBe(a.ino);
    expect(b.nlink).toBeGreaterThan(1);
  });

  test("同じブランチを 2 つの repodir で同時に checkout できる (worktree では不可能)", async () => {
    const a = await createRepodir(cfg, spec(), { from: "develop" }, "0.1.0");
    const b = await createRepodir(cfg, spec(), { from: "develop" }, "0.1.0");

    expect(a.path).not.toBe(b.path);
    for (const r of [a, b]) {
      expect(await git(["branch", "--show-current"], r.path)).toBe("develop");
      expect(await Bun.file(join(r.path, "dev.md")).exists()).toBe(true);
    }
  });

  test("--from で起点ブランチを選べる。省略時は default branch", async () => {
    const def = await createRepodir(cfg, spec(), {}, "0.1.0");
    expect(def.meta.baseBranch).toBe("main");

    const dev = await createRepodir(cfg, spec(), { from: "develop" }, "0.1.0");
    expect(dev.meta.baseBranch).toBe("develop");
    expect(dev.meta.baseCommit).not.toBe(def.meta.baseCommit);
  });

  test("baseCommit が実際の HEAD と一致する", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    expect(r.meta.baseCommit).toBe(await git(["rev-parse", "HEAD"], r.path));
    expect(r.meta.baseCommit).toHaveLength(40);
  });

  test("ccx.json に生成時の不変情報だけを書く", async () => {
    const r = await createRepodir(
      cfg,
      spec(),
      {
        initialTask: "PR のレビュー指摘を修正",
        goal: { issue: "test-owner/demo#12" },
        pr: { milestone: "v1.0.0", reviewers: ["someone"] },
        model: "opus-4.8",
      },
      "0.1.0",
    );

    const meta = await readMeta(r.path);
    expect(meta).toMatchObject({
      schema: 1,
      initialTask: "PR のレビュー指摘を修正",
      goal: { issue: "test-owner/demo#12" },
      pr: { milestone: "v1.0.0", reviewers: ["someone"] },
      agent: "claude",
      model: "opus-4.8",
      baseBranch: "main",
      ccxVersion: "0.1.0",
    });

    // path / git から導出できるものは持たない
    expect(meta).not.toHaveProperty("host");
    expect(meta).not.toHaveProperty("repo");
    expect(meta).not.toHaveProperty("machine");
    expect(meta).not.toHaveProperty("branch");
    expect(meta).not.toHaveProperty("session");
  });

  test("空の goal / pr は書かない", async () => {
    const r = await createRepodir(cfg, spec(), { goal: {}, pr: {} }, "0.1.0");
    const meta = await readMeta(r.path);

    expect(meta).not.toHaveProperty("goal");
    expect(meta).not.toHaveProperty("pr");
  });

  test("ccx.state は desired: stopped で初期化する (ccxd が勝手に session を立てない)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    expect(await readState(r.path)).toEqual({ desired: "stopped", done: null });
  });

  test("メタデータは .git 配下なので working tree を汚さない", async () => {
    const r = await createRepodir(cfg, spec(), { initialTask: "x" }, "0.1.0");

    const status = await git(["status", "--porcelain"], r.path);
    expect(status).toBe("");
  });

  test("createdBy: session 内なら session id、そうでなければ user", async () => {
    const r1 = await createRepodir(cfg, spec(), {}, "0.1.0");
    expect(r1.meta.createdBy).toBe("user");

    process.env.CLAUDE_SESSION_ID = "abc-123";
    try {
      const r2 = await createRepodir(cfg, spec(), {}, "0.1.0");
      expect(r2.meta.createdBy).toBe("session:abc-123");
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
    }
  });

  test("2 回目以降は mirror を再利用する (新鮮なら update もしない)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    expect(r.mirror.created).toBe(false);
    expect(r.mirror.updated).toBe(false);
  });

  test("--refresh で mirror を強制更新する", async () => {
    const r = await createRepodir(cfg, spec(), { refresh: true }, "0.1.0");
    expect(r.mirror.updated).toBe(true);
  });

  test("存在しないブランチを指定したら失敗する", async () => {
    expect(createRepodir(cfg, spec(), { from: "no-such-branch" }, "0.1.0")).rejects.toThrow();
  });
});

describe("protocol", () => {
  /** mirror を共有しないよう、protocol のテストは独立した root を使う */
  const sshCfg = (): Config => ({
    ...cfg,
    root: join(tmp, "repodirs-ssh"),
    mirrorRoot: join(tmp, "mirror-ssh"),
    protocol: "ssh",
  });

  test("protocol = ssh なら mirror も repodir の origin も ssh URL になる", async () => {
    const c = sshCfg();
    const r = await createRepodir(c, spec(), {}, "0.1.0");

    const origin = await git(["config", "--get", "remote.origin.url"], r.path);
    expect(origin).toBe(SSH_REMOTE);

    const mirrorOrigin = await git(
      ["config", "--get", "remote.origin.url"],
      mirrorPath(c, spec()),
    );
    expect(mirrorOrigin).toBe(SSH_REMOTE);
  });

  test("呼び出し単位で protocol を上書きできる (設定が https でも ssh で作れる)", async () => {
    const c: Config = { ...sshCfg(), protocol: "https", mirrorRoot: join(tmp, "mirror-override") };
    const r = await createRepodir(c, spec(), { protocol: "ssh" }, "0.1.0");

    expect(await git(["config", "--get", "remote.origin.url"], r.path)).toBe(SSH_REMOTE);
  });

  test("mirror がまだ無い repo に同時に repodir を作っても、誰も落ちない", async () => {
    // 同じ repo に並列でエージェントを立てるのは、この道具の中心的な使い方そのもの。
    // mirror path へ直接 clone していた頃は、負けた側が destination path already exists で
    // 落ちていた (5 並列で 2 本 exit 1 を実測)。
    const c: Config = { ...cfg, root: join(tmp, "repodirs-race"), mirrorRoot: join(tmp, "mirror-race") };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createRepodir(c, spec(), {}, "0.1.0")),
    );

    // mirror を作れたのはちょうど 1 人。残りは勝者の mirror から生える
    expect(results.filter((r) => r.mirror.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.path)).size).toBe(5);
    for (const r of results) {
      expect(await Bun.file(join(r.path, "README.md")).exists()).toBe(true);
    }

    // 敗者の temp が残っていない
    const leftovers = [
      ...new Bun.Glob("*.tmp-*").scanSync({ cwd: join(tmp, "mirror-race", "github.com", "test-owner"), onlyFiles: false }),
    ];
    expect(leftovers).toBeEmpty();
  });

  test("origin の付け替えに失敗しても、repodir の生成そのものは諦めない", async () => {
    // 並行実行で .git/config のロックを取り損ねる状況を、config を書けなくして再現する。
    // origin の付け替えは fetch の下準備でしかなく、それだけで生成を諦めるのは割に合わない。
    const c: Config = { ...cfg, root: join(tmp, "repodirs-lock"), mirrorRoot: join(tmp, "mirror-lock") };
    await createRepodir(c, spec(), {}, "0.1.0");

    const mirror = mirrorPath(c, spec());
    await chmod(join(mirror, "config"), 0o444);

    try {
      // protocol を変えて set-url を必ず走らせる。書けないので失敗するが、落ちてはいけない
      const r = await createRepodir({ ...c, protocol: "ssh" }, spec(), {}, "0.1.0");
      expect(await Bun.file(join(r.path, "README.md")).exists()).toBe(true);
    } finally {
      await chmod(join(mirror, "config"), 0o644);
    }
  });

  test("origin を失った mirror でも、落ちずに origin を作り直して使える", async () => {
    // git remote set-url は remote を作れない (No such remote 'origin' で終わる)。origin が
    // 消えた mirror を掴んだとき、set-url に頼っていると mirror ごと使えなくなる。
    const c: Config = { ...cfg, root: join(tmp, "repodirs-noorigin"), mirrorRoot: join(tmp, "mirror-noorigin") };
    await createRepodir(c, spec(), {}, "0.1.0");

    const mirror = mirrorPath(c, spec());
    await git(["remote", "remove", "origin"], mirror);

    const r = await createRepodir(c, spec(), { refresh: true }, "0.1.0");

    expect(r.mirror.updated).toBe(true);
    expect(await git(["config", "--get", "remote.origin.url"], mirror)).toBe(REMOTE);
    // bare mirror の origin は普通の remote と違う。refspec と mirror フラグまで戻っていないと
    // 次の remote update が期待どおりに動かない
    expect(await git(["config", "--get", "remote.origin.fetch"], mirror)).toBe("+refs/*:refs/*");
    expect(await git(["config", "--get", "remote.origin.mirror"], mirror)).toBe("true");
  });

  test("既存 mirror の origin は、protocol を切り替えると追従する", async () => {
    const c: Config = { ...cfg, root: join(tmp, "repodirs-switch"), mirrorRoot: join(tmp, "mirror-switch") };

    await createRepodir(c, spec(), {}, "0.1.0");
    const mirror = mirrorPath(c, spec());
    expect(await git(["config", "--get", "remote.origin.url"], mirror)).toBe(REMOTE);

    // 同じ mirror を ssh で引き直す。origin が古いままだと fetch が旧 protocol に飛ぶ
    await createRepodir({ ...c, protocol: "ssh" }, spec(), {}, "0.1.0");
    expect(await git(["config", "--get", "remote.origin.url"], mirror)).toBe(SSH_REMOTE);
  });
});
