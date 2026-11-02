/**
 * createRepodir の統合テスト。
 *
 * ネットワークに出ずに本番コードパスを通すため、git の insteadOf でリモート URL を
 * ローカルの bare repo に書き換える (GIT_CONFIG_GLOBAL)。cloneUrl() やその後の
 * remote set-url は production の実装がそのまま走る。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { DIR_ID_LENGTH, isDirId } from "./dirid.ts";
import { git, gitBare } from "./git.ts";
import { readMeta, readState } from "./meta.ts";
import { ensureMirror, mirrorPath } from "./mirror.ts";
import { createRepodir } from "./repodir.ts";
import { explicitCloneUrl, parseRepoSpec } from "./repospec.ts";

const REMOTE = "https://github.com/test-owner/demo.git";
// 平文の http で既定外のポートに立つ自前の forge (Forgejo / Gitea)。#215
const HTTP_FORGE = "http://localhost:13000/test-owner/demo.git";
const HTTPS_FORGE = "https://localhost:13000/test-owner/demo.git";
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
    `[url "file://${source}"]\n\tinsteadOf = ${REMOTE}\n\tinsteadOf = ${SSH_REMOTE}\n\tinsteadOf = ${HTTP_FORGE}\n\tinsteadOf = ${HTTPS_FORGE}\n`,
  );
  originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;

  cfg = {
    root: join(tmp, "repodirs"),
    mirrorRoot: join(tmp, "repodirs", ".mirror"),
    defaultHost: "github.com",
    machine: "test-machine",
    protocol: "https",
    mirrorMaxAgeMs: 600_000,
    defaults: { agent: "claude" },
    resume: { command: "claude --resume {session_id}", agent: "claude" },
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

  test("ccx.state は desired: stopped で初期化する (ccx-agent が勝手に session を立てない)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    expect(await readState(r.path)).toEqual({ desired: "stopped", done: null });
  });

  test("メタデータは .git 配下なので working tree を汚さない", async () => {
    const r = await createRepodir(cfg, spec(), { initialTask: "x" }, "0.1.0");

    const status = await git(["status", "--porcelain"], r.path);
    expect(status).toBe("");
  });

  /**
   * env は明示的に落としてから組み立てる。テスト自体が Claude session 内で走ることがあり、
   * その場合 CLAUDE_CODE_SESSION_ID は既に入っている。消さずに書くと「session 外なら user」
   * 側が環境次第で落ちる。
   */
  test("createdBy: session 内なら session id、そうでなければ user", async () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const r1 = await createRepodir(cfg, spec(), {}, "0.1.0");
      expect(r1.meta.createdBy).toBe("user");

      process.env.CLAUDE_CODE_SESSION_ID = "abc-123";
      const r2 = await createRepodir(cfg, spec(), {}, "0.1.0");
      expect(r2.meta.createdBy).toBe("session:abc-123");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = saved;
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

  test("存在しないブランチを指定したら失敗し、取った dir-id のディレクトリも残さない (#235)", async () => {
    const parent = join(cfg.root, "github.com", "test-owner", "demo");
    const before = (await readdir(parent)).sort();
    await expect(createRepodir(cfg, spec(), { from: "no-such-branch" }, "0.1.0")).rejects.toThrow(/no-such-branch/);
    expect((await readdir(parent)).sort()).toEqual(before);
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

  test("config が壊れた mirror を、origin 不在と誤読して黙って上書きしない", async () => {
    // git config --get は「キーが無い」を終了コード 1 で表す。壊れた config は 128 で落ちる。
    // これを区別せずに握ると、読めなかった設定を origin 不在とみなして書き潰す。
    const c: Config = { ...cfg, root: join(tmp, "repodirs-broken"), mirrorRoot: join(tmp, "mirror-broken") };
    await createRepodir(c, spec(), {}, "0.1.0");

    const configPath = join(mirrorPath(c, spec()), "config");
    const before = await Bun.file(configPath).text();
    await Bun.write(configPath, `${before}[core\n  broken\n`);

    await expect(createRepodir(c, spec(), { refresh: true }, "0.1.0")).rejects.toThrow();

    // 壊れた config は壊れたまま残る (勝手に書き直していない)
    expect(await Bun.file(configPath).text()).toContain("[core\n  broken");
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

  test("protocol を切り替えると、新しい URL で実際に fetch し直す", async () => {
    const c: Config = { ...cfg, root: join(tmp, "repodirs-switch"), mirrorRoot: join(tmp, "mirror-switch") };

    await createRepodir(c, spec(), {}, "0.1.0");
    const mirror = mirrorPath(c, spec());
    expect(await git(["config", "--get", "remote.origin.url"], mirror)).toBe(REMOTE);

    // origin が新 URL に変わったことだけを見ても、その URL で本当に取ってこられるかは分からない。
    // forge に新しい commit を積み、ssh で引き直して、それが mirror に届くところまでを通す。
    await git(["switch", "--quiet", "main"], join(tmp, "work"));
    await Bun.write(join(tmp, "work", "after-switch.md"), "new\n");
    await git(["add", "after-switch.md"], join(tmp, "work"));
    await git(["commit", "--quiet", "-m", "after switch"], join(tmp, "work"));
    await git(["push", "--quiet", source, "main"], join(tmp, "work"));
    const head = await git(["rev-parse", "main"], join(tmp, "work"));

    // refresh: true で鮮度チェックを外し、実際に remote update を走らせる
    const r = await createRepodir({ ...c, protocol: "ssh" }, spec(), { refresh: true }, "0.1.0");

    expect(r.mirror.updated).toBe(true);
    expect(await git(["config", "--get", "remote.origin.url"], mirror)).toBe(SSH_REMOTE);
    // ssh の URL 経由で新しい commit が mirror と repodir の両方に届いている
    expect(await git(["rev-parse", "refs/heads/main"], mirror)).toBe(head);
    expect(await Bun.file(join(r.path, "after-switch.md")).exists()).toBe(true);
  });
});

describe("an explicit http / port URL (#215)", () => {
  const origin = (path: string) => git(["config", "--get", "remote.origin.url"], path);

  test("is the mirror's origin, later rd new without it keeps it, and an explicit protocol replaces it", async () => {
    const forge = parseRepoSpec(HTTP_FORGE, { defaultHost: "github.com" });
    expect(forge).toEqual({ host: "localhost:13000", owner: "test-owner", repo: "demo" });

    const first = await createRepodir(cfg, forge, { url: explicitCloneUrl(HTTP_FORGE) }, "0.1.0");
    expect(await origin(first.path)).toBe(HTTP_FORGE);
    expect(await origin(mirrorPath(cfg, forge))).toBe(HTTP_FORGE);

    // scheme の無い指定と refresh: 設定の https で書き換えない (mirror があるとき。無ければ https で取りに行く)
    const again = await createRepodir(cfg, parseRepoSpec("localhost:13000/test-owner/demo", { defaultHost: "github.com" }), { refresh: true }, "0.1.0");
    expect(await origin(again.path)).toBe(HTTP_FORGE);
    expect(await origin(mirrorPath(cfg, forge))).toBe(HTTP_FORGE);

    // 別の明示 URL を渡せば付け替える (認証情報は落とす)
    const viaUrl = await createRepodir(cfg, forge, { url: explicitCloneUrl("https://me:secret@localhost:13000/test-owner/demo.git") }, "0.1.0");
    expect(await origin(viaUrl.path)).toBe(HTTPS_FORGE);
    expect(await origin(mirrorPath(cfg, forge))).toBe(HTTPS_FORGE);

    // protocol を明示しても付け替える
    await createRepodir(cfg, forge, { url: explicitCloneUrl(HTTP_FORGE) }, "0.1.0");
    const switched = await createRepodir(cfg, forge, { protocol: "https" }, "0.1.0");
    expect(await origin(switched.path)).toBe(HTTPS_FORGE);
    expect(await origin(mirrorPath(cfg, forge))).toBe(HTTPS_FORGE);
  });
});

describe("createRepodir の失敗", () => {
  test("clone の後の手順で落ちたら、作りかけの repodir を残さない (#235)", async () => {
    // 取れない submodule を持つ repo: clone は通り、submodule update で落ちる
    const work = join(tmp, "broken-work");
    const src = join(tmp, "broken.git");
    await git(["init", "--quiet", "--initial-branch", "main", work]);
    await git(["config", "user.email", "t@example.com"], work);
    await git(["config", "user.name", "t"], work);
    await Bun.write(join(work, ".gitmodules"), `[submodule "sub"]\n\tpath = sub\n\turl = file://${join(tmp, "no-such.git")}\n`);
    await git(["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`], work);
    await git(["add", ".gitmodules"], work);
    await git(["commit", "--quiet", "-m", "sub"], work);
    await git(["clone", "--quiet", "--bare", work, src]);
    await git(["config", "--global", "--add", `url.file://${src}.insteadOf`, "https://github.com/test-owner/broken.git"]);

    const broken = parseRepoSpec("test-owner/broken", { defaultHost: "github.com" });
    // 落ちた理由まで見る (コマンド名の submodule には当てない)
    await expect(createRepodir(cfg, broken, {}, "0.1.0")).rejects.toThrow(/no-such\.git/);
    expect(await readdir(join(cfg.root, "github.com", "test-owner", "broken"))).toEqual([]);

    // submodule を取らなければ同じ repo でも作れる (落ちたのが clone の後だったことの確認)
    const ok = await createRepodir(cfg, broken, { recurseSubmodules: false }, "0.1.0");
    expect(await readdir(join(cfg.root, "github.com", "test-owner", "broken"))).toEqual([ok.dirId]);
  });
});

describe("createRepodir の失敗 (checkout)", () => {
  test("clone の checkout で落ちても、git が残した作りかけを残さない (#235)", async () => {
    // 必須の smudge filter が落ちる repo: git は "Clone succeeded, but checkout failed" で .git を残す
    const work = join(tmp, "nocheckout-work");
    const src = join(tmp, "nocheckout.git");
    await git(["init", "--quiet", "--initial-branch", "main", work]);
    await git(["config", "user.email", "t@example.com"], work);
    await git(["config", "user.name", "t"], work);
    await Bun.write(join(work, ".gitattributes"), "*.txt filter=ccxfail\n");
    await Bun.write(join(work, "a.txt"), "a\n");
    await git(["add", ".gitattributes", "a.txt"], work);
    await git(["commit", "--quiet", "-m", "filtered"], work);
    await git(["clone", "--quiet", "--bare", work, src]);
    await git(["config", "--global", "--add", `url.file://${src}.insteadOf`, "https://github.com/test-owner/nocheckout.git"]);
    await git(["config", "--global", "filter.ccxfail.smudge", "false"]);
    await git(["config", "--global", "filter.ccxfail.required", "true"]);

    const spec = parseRepoSpec("test-owner/nocheckout", { defaultHost: "github.com" });
    // checkout で落ちたこと (mirror の取得で落ちたのなら git が自分で片付けるので、この試験にならない)
    await expect(createRepodir(cfg, spec, {}, "0.1.0")).rejects.toThrow(/checkout failed/);
    expect(await readdir(join(cfg.root, "github.com", "test-owner", "nocheckout"))).toEqual([]);
  });
});

describe("safe.bareRepository=explicit (#275)", () => {
  const KEYS = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "safe.bareRepository";
    process.env.GIT_CONFIG_VALUE_0 = "explicit";
  });

  afterAll(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("git -C で bare を開くと拒否される (この環境が explicit を実際に効かせている)", async () => {
    await expect(git(["symbolic-ref", "HEAD"], source)).rejects.toThrow("safe.bareRepository");
  });

  test("mirror の作成・再利用・強制更新・default branch の解決がすべて通る", async () => {
    const own: Config = { ...cfg, root: join(tmp, "explicit-root"), mirrorRoot: join(tmp, "explicit-root", ".mirror") };

    const first = await createRepodir(own, spec(), {}, "0.1.0");
    expect(first.mirror.created).toBe(true);

    const second = await createRepodir(own, spec(), { refresh: true }, "0.1.0");
    expect(second.mirror.created).toBe(false);
    expect(second.mirror.updated).toBe(true);
    expect(await Bun.file(join(second.path, "README.md")).exists()).toBe(true);
    // 読み損ねた origin は「無い」と同じ exit 1 になり、付け替えの失敗は警告に落ちて成功に見える。保存値で確かめる
    expect(await gitBare(["config", "--get", "remote.origin.url"], mirrorPath(own, spec()))).toBe(REMOTE);
  });

  test("origin の付け替え (config の書き込み) も通る", async () => {
    const own: Config = { ...cfg, root: join(tmp, "explicit-root-sw"), mirrorRoot: join(tmp, "explicit-root-sw", ".mirror") };
    const first = await createRepodir(own, spec(), {}, "0.1.0");
    expect(await gitBare(["config", "--get", "remote.origin.url"], mirrorPath(own, spec()))).toBe(REMOTE);

    const ssh = await createRepodir(own, spec(), { protocol: "ssh" }, "0.1.0");
    expect(await gitBare(["config", "--get", "remote.origin.url"], mirrorPath(own, spec()))).toBe(SSH_REMOTE);
  });

  test("origin が無い mirror にも origin を書き戻せる", async () => {
    const own: Config = { ...cfg, root: join(tmp, "explicit-root-no"), mirrorRoot: join(tmp, "explicit-root-no", ".mirror") };
    await createRepodir(own, spec(), {}, "0.1.0");
    const path = mirrorPath(own, spec());
    await gitBare(["config", "--unset-all", "remote.origin.url"], path);
    await gitBare(["config", "--unset-all", "remote.origin.fetch"], path);
    await gitBare(["config", "--unset-all", "remote.origin.mirror"], path);

    await createRepodir(own, spec(), {}, "0.1.0");
    expect(await gitBare(["config", "--get", "remote.origin.url"], path)).toBe(REMOTE);
    expect(await gitBare(["config", "--get", "remote.origin.fetch"], path)).toBe("+refs/*:refs/*");
    expect(await gitBare(["config", "--get", "remote.origin.mirror"], path)).toBe("true");
  });

  for (const [name, unset] of [
    ["url だけ書かれた mirror", ["remote.origin.fetch", "remote.origin.mirror"]],
    ["url と fetch だけ書かれた mirror", ["remote.origin.mirror"]],
    ["url と mirror だけ書かれた mirror", ["remote.origin.fetch"]],
  ] as const) {
    test(`復旧が中断された (${name}) も、次の呼び出しで残りを書き戻し、新しい commit を取る`, async () => {
      const own: Config = { ...cfg, root: join(tmp, `partial-${unset.length}-${unset[0]}`), mirrorRoot: join(tmp, `partial-m-${unset.length}-${unset[0]}`) };
      await createRepodir(own, spec(), {}, "0.1.0");
      const path = mirrorPath(own, spec());
      for (const k of unset) await gitBare(["config", "--unset-all", k], path);

      await git(["switch", "--quiet", "main"], join(tmp, "work"));
      await Bun.write(join(tmp, "work", `partial-${unset.length}-${unset[0]}.md`), "new\n");
      await git(["add", "."], join(tmp, "work"));
      await git(["commit", "--quiet", "-m", "partial"], join(tmp, "work"));
      await git(["push", "--quiet", source, "main"], join(tmp, "work"));
      const head = await git(["rev-parse", "main"], join(tmp, "work"));

      await createRepodir(own, spec(), { refresh: true }, "0.1.0");
      expect(await gitBare(["config", "--get", "remote.origin.url"], path)).toBe(REMOTE);
      expect(await gitBare(["config", "--get", "remote.origin.fetch"], path)).toBe("+refs/*:refs/*");
      expect(await gitBare(["config", "--get", "remote.origin.mirror"], path)).toBe("true");
      expect(await gitBare(["rev-parse", "refs/heads/main"], path)).toBe(head);
    });
  }

  test("別の refspec と mirror=false の mirror に、mirror の refspec を足して mirror=true にする (既存の行は残す)", async () => {
    const own: Config = { ...cfg, root: join(tmp, "wrongval"), mirrorRoot: join(tmp, "wrongval-m") };
    await createRepodir(own, spec(), {}, "0.1.0");
    const path = mirrorPath(own, spec());
    await gitBare(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], path);
    await gitBare(["config", "--add", "remote.origin.fetch", "^refs/pull/*"], path);
    await gitBare(["config", "--bool", "remote.origin.mirror", "false"], path);

    await createRepodir(own, spec(), { refresh: true }, "0.1.0");
    // 利用者が足した行は消さずに、mirror の refspec だけを足す
    expect((await gitBare(["config", "--get-all", "remote.origin.fetch"], path)).split("\n")).toEqual([
      "+refs/heads/*:refs/remotes/origin/*",
      "^refs/pull/*",
      "+refs/*:refs/*",
    ]);
    expect(await gitBare(["config", "--get", "remote.origin.mirror"], path)).toBe("true");
  });

  test("refspec が複数行あっても警告せず、mirror の行が既にあれば config を書き換えない", async () => {
    const own: Config = { ...cfg, root: join(tmp, "multival"), mirrorRoot: join(tmp, "multival-m") };
    await createRepodir(own, spec(), {}, "0.1.0");
    const path = mirrorPath(own, spec());
    await gitBare(["config", "--add", "remote.origin.fetch", "^refs/pull/*"], path);
    await gitBare(["config", "remote.origin.mirror", "yes"], path);
    const before = await Bun.file(join(path, "config")).text();

    const warnings: string[] = [];
    const r = await ensureMirror(own, spec(), { force: true, warn: (m) => warnings.push(m) });
    expect(r.updated).toBe(true);
    expect(warnings).toEqual([]);
    expect(await Bun.file(join(path, "config")).text()).toBe(before);
  });

  test("明示 URL の mirror でも、欠けた refspec を書き戻す", async () => {
    const own: Config = { ...cfg, root: join(tmp, "explicit-repair"), mirrorRoot: join(tmp, "explicit-repair-m") };
    const forge = parseRepoSpec(HTTP_FORGE, { defaultHost: "github.com" });
    await createRepodir(own, forge, { url: explicitCloneUrl(HTTP_FORGE) }, "0.1.0");
    const path = mirrorPath(own, forge);
    await gitBare(["config", "--unset-all", "remote.origin.fetch"], path);

    await createRepodir(own, forge, { refresh: true }, "0.1.0");
    expect(await gitBare(["config", "--get", "remote.origin.url"], path)).toBe(HTTP_FORGE);
    expect(await gitBare(["config", "--get", "remote.origin.fetch"], path)).toBe("+refs/*:refs/*");
  });

  test("壊れた mirror フラグ (git が exit 128) は上書きせず、警告に落とす", async () => {
    const own: Config = { ...cfg, root: join(tmp, "badbool"), mirrorRoot: join(tmp, "badbool-m") };
    await createRepodir(own, spec(), {}, "0.1.0");
    const path = mirrorPath(own, spec());
    await gitBare(["config", "remote.origin.mirror", "maybe"], path);
    const before = await Bun.file(join(path, "config")).text();

    const warnings: string[] = [];
    // git 自身も壊れた bool では remote update に失敗する。ここで見るのは警告と config が無傷なこと
    await ensureMirror(own, spec(), { force: true, warn: (m) => warnings.push(m) }).catch(() => undefined);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("could not update the mirror's origin config");
    expect(await Bun.file(join(path, "config")).text()).toBe(before);
  });

  // config.lock を置くと git config の書き込みだけが失敗し、読み取りは通る (並行実行のロック競合と同じ形)
  async function lockedMirror(name: string, breakConfig: (path: string) => Promise<void>) {
    const own: Config = { ...cfg, root: join(tmp, name), mirrorRoot: join(tmp, `${name}-m`) };
    await createRepodir(own, spec(), {}, "0.1.0");
    const path = mirrorPath(own, spec());
    await breakConfig(path);
    const before = await gitBare(["rev-parse", "refs/heads/main"], path);

    await git(["switch", "--quiet", "main"], join(tmp, "work"));
    await Bun.write(join(tmp, "work", `${name}.md`), "new\n");
    await git(["add", "."], join(tmp, "work"));
    await git(["commit", "--quiet", "-m", name], join(tmp, "work"));
    await git(["push", "--quiet", source, "main"], join(tmp, "work"));
    const head = await git(["rev-parse", "main"], join(tmp, "work"));

    await Bun.write(join(path, "config.lock"), "");
    return { own, path, before, head };
  }

  for (const [name, breakConfig] of [
    ["refspec が欠けた", (p: string) => gitBare(["config", "--unset-all", "remote.origin.fetch"], p)],
    ["mirror フラグが false の", (p: string) => gitBare(["config", "--bool", "remote.origin.mirror", "false"], p)],
  ] as const) {
    test(`修復の書き込みが失敗し、読み直しても ${name} mirror は、更新せずに投げる`, async () => {
      const { own, path, before } = await lockedMirror(`locked-${name}`, async (p) => void (await breakConfig(p)));

      const warnings: string[] = [];
      try {
        await expect(ensureMirror(own, spec(), { force: true, warn: (m) => warnings.push(m) })).rejects.toThrow(
          "the mirror's origin config is incomplete",
        );
        expect(warnings.length).toBe(1);
        expect(await gitBare(["rev-parse", "refs/heads/main"], path)).toBe(before);
      } finally {
        await rm(join(path, "config.lock"), { force: true });
      }
    });
  }

  test("修復の書き込みが失敗しても、読み直して並行する修復が書き終えていれば、更新して updated を返す", async () => {
    const { own, path, head } = await lockedMirror("locked-raced", (p) =>
      gitBare(["config", "--unset-all", "remote.origin.fetch"], p).then(() => undefined),
    );

    // 警告は修復の失敗直後・読み直しの前に出る。そこで競合相手がロックを手放して書き終えた状態を作る
    const warnings: string[] = [];
    const r = await ensureMirror(own, spec(), {
      force: true,
      warn: (m) => {
        warnings.push(m);
        Bun.spawnSync(["rm", "-f", join(path, "config.lock")]);
        Bun.spawnSync(["git", "--git-dir", path, "config", "remote.origin.fetch", "+refs/*:refs/*"]);
      },
    });
    expect(r.updated).toBe(true);
    expect(warnings.length).toBe(1);
    expect(await gitBare(["rev-parse", "refs/heads/main"], path)).toBe(head);
  });

  test("url の付け替えに失敗しても、警告して元の origin で更新する", async () => {
    const { own, path, head } = await lockedMirror("locked-url", async () => undefined);
    const other = `${REMOTE}-moved`;

    const warnings: string[] = [];
    try {
      const r = await ensureMirror(own, spec(), { force: true, url: other, warn: (m) => warnings.push(m) });
      expect(r.updated).toBe(true);
      expect(warnings).toEqual([expect.stringContaining(`could not point the mirror at ${other}`)]);
      expect(await gitBare(["config", "--get", "remote.origin.url"], path)).toBe(REMOTE);
      expect(await gitBare(["rev-parse", "refs/heads/main"], path)).toBe(head);
    } finally {
      await rm(join(path, "config.lock"), { force: true });
    }
  });
});
