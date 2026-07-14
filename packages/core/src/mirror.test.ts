/**
 * mirror の鮮度ポリシー。
 *
 * 決めごとは 2 つで、どちらも「repodir が作れること」を鮮度より優先する:
 *
 *   - mirrorMaxAge を超えていたら remote update する。--refresh で強制、--no-refresh で無効化。
 *   - 更新に失敗しても落とさない。古い mirror のまま repodir を作り、stderr で警告する。
 *     オフラインでも repodir が作れることは設計上の売りであり、鮮度のために可用性は捨てない。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { git } from "./git.ts";
import { ensureMirror, mirrorPath } from "./mirror.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";

const REMOTE = "https://github.com/test-owner/demo.git";
/** 途中で消える forge。「mirror はあるが remote に届かない」= オフラインを再現する */
const VANISH_REMOTE = "https://github.com/test-owner/vanish.git";
/** 最初から届かない forge。mirror すら作れないケース */
const MISSING_REMOTE = "https://github.com/test-owner/missing.git";

let tmp: string;
let source: string;
let vanish: string;
let cfg: Config;
let originalGitConfigGlobal: string | undefined;

const spec = () => parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });
const vanishSpec = () => parseRepoSpec("test-owner/vanish", { defaultHost: "github.com" });

/** mirror の最終 fetch 時刻を過去にずらして「古い」状態を作る */
async function ageMirror(path: string, ms: number): Promise<void> {
  const t = new Date(Date.now() - ms);
  for (const f of ["FETCH_HEAD", "packed-refs", "HEAD"]) {
    try {
      await utimes(join(path, f), t, t);
    } catch {
      // 無いファイルは飛ばす (lastFetchedAt が見る順と同じ)
    }
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-mirror-"));
  source = join(tmp, "source.git");

  const work = join(tmp, "work");
  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["clone", "--quiet", "--bare", work, source]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], source);

  // 消せる forge。mirror を作った後にこれを消すと「remote に届かない」状態になる
  vanish = join(tmp, "vanish.git");
  await git(["clone", "--quiet", "--bare", work, vanish]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], vanish);

  // network に出ないよう、テストで使う URL は全てローカル path に読み替える
  const gitconfig = join(tmp, "gitconfig");
  await Bun.write(
    gitconfig,
    [
      `[url "file://${source}"]`,
      `\tinsteadOf = ${REMOTE}`,
      `[url "file://${vanish}"]`,
      `\tinsteadOf = ${VANISH_REMOTE}`,
      `[url "file://${join(tmp, "does-not-exist.git")}"]`,
      `\tinsteadOf = ${MISSING_REMOTE}`,
      "",
    ].join("\n"),
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

beforeEach(async () => {
  await rm(cfg.mirrorRoot, { recursive: true, force: true });
});

describe("ensureMirror の鮮度判定", () => {
  test("無ければ作る", async () => {
    const r = await ensureMirror(cfg, spec());

    expect(r).toMatchObject({ created: true, updated: false, stale: false });
    expect(r.path).toBe(mirrorPath(cfg, spec()));
  });

  test("新鮮なら remote に触らない", async () => {
    await ensureMirror(cfg, spec());
    const r = await ensureMirror(cfg, spec());

    expect(r).toMatchObject({ created: false, updated: false, stale: false });
  });

  test("mirrorMaxAge を超えていたら更新する", async () => {
    const first = await ensureMirror(cfg, spec());
    await ageMirror(first.path, cfg.mirrorMaxAgeMs + 60_000);

    const r = await ensureMirror(cfg, spec());
    expect(r).toMatchObject({ created: false, updated: true, stale: false });
  });

  test("refresh: true は新鮮でも強制更新する", async () => {
    await ensureMirror(cfg, spec());

    const r = await ensureMirror(cfg, spec(), { refresh: true });
    expect(r).toMatchObject({ created: false, updated: true, stale: false });
  });

  test("refresh: false は古くても鮮度チェックごと飛ばす", async () => {
    const first = await ensureMirror(cfg, spec());
    await ageMirror(first.path, cfg.mirrorMaxAgeMs * 10);

    const r = await ensureMirror(cfg, spec(), { refresh: false });
    expect(r).toMatchObject({ created: false, updated: false, stale: false });
  });
});

describe("更新に失敗しても repodir は作れる (オフライン耐性)", () => {
  /** mirror を作った後に forge を消し、「古い mirror はあるが remote に届かない」を作る */
  async function mirrorThenGoOffline(ageMs: number): Promise<string> {
    const first = await ensureMirror(cfg, vanishSpec());
    await ageMirror(first.path, ageMs);
    await rm(vanish, { recursive: true, force: true });
    return first.path;
  }

  beforeEach(async () => {
    // 各テストが forge を消すので、都度 clone し直す
    await rm(vanish, { recursive: true, force: true });
    await git(["clone", "--quiet", "--bare", source, vanish]);
  });

  test("古い mirror の更新に失敗しても、落とさず古いまま使う", async () => {
    await mirrorThenGoOffline(cfg.mirrorMaxAgeMs + 60_000);

    const r = await ensureMirror(cfg, vanishSpec());

    expect(r).toMatchObject({ created: false, updated: false, stale: true });
    // mirror は壊れておらず、object も残っている (repodir はここから生やせる)
    expect(await git(["rev-parse", "--is-bare-repository"], r.path)).toBe("true");
    expect(await git(["rev-parse", "--verify", "refs/heads/main"], r.path)).toBeTruthy();
  });

  test("古いまま使うときは警告する (黙って古い repodir を生やさない)", async () => {
    await mirrorThenGoOffline(3 * 3_600_000);

    const r = await ensureMirror(cfg, vanishSpec());

    const out = r.warnings.join("\n");
    expect(out).toContain("could not update the mirror");
    expect(out).toContain("3h");
    expect(out).toContain("test-owner/vanish");
  });

  test("refresh: true でも、更新に失敗したら落とさず警告する", async () => {
    await mirrorThenGoOffline(0);

    const r = await ensureMirror(cfg, vanishSpec(), { refresh: true });

    expect(r.stale).toBe(true);
    expect(r.warnings.join("\n")).toContain("could not update the mirror");
  });

  test("refresh: false ならオフラインでも警告すら出ない (remote に触らないため)", async () => {
    await mirrorThenGoOffline(cfg.mirrorMaxAgeMs * 10);

    const r = await ensureMirror(cfg, vanishSpec(), { refresh: false });

    expect(r).toMatchObject({ updated: false, stale: false });
    expect(r.warnings).toBeEmpty();
  });

  test("mirror がまだ無いときの失敗は投げる (古い mirror すら無いので続行できない)", async () => {
    const missing = parseRepoSpec("test-owner/missing", { defaultHost: "github.com" });

    expect(ensureMirror(cfg, missing)).rejects.toThrow();
  });

  test("mirror が壊れているときは、続行を約束せずに落ちる (警告が嘘にならないように)", async () => {
    // オフラインで古いだけなら続行してよい。だが mirror が壊れていれば、そこからの clone も
    // 落ちる。「古いまま続行します」と言った直後に死ぬのがいちばん質が悪いので、警告は clone が
    // 通ってから出す。壊れていた場合はここで落ち、直し方 (捨てて引き直す) を言う。
    const first = await ensureMirror(cfg, vanishSpec());
    await ageMirror(first.path, cfg.mirrorMaxAgeMs + 60_000);

    // pack の中身を潰す。HEAD の commit ではなく blob が壊れるので、安い健全性チェック
    // (cat-file -e HEAD^{commit}) では検出できない。clone してみるまで分からない。
    // mirror を読めなくする。object が pack にまとまっているか loose か、hardlink かは git の
    // バージョンと設定で変わるので、レイアウトに依存しないよう object store ごと空にする。refs は
    // 残るので「参照はあるが中身が読めない mirror」になり、そこからの clone は必ず落ちる。
    const objects = join(first.path, "objects");
    await rm(objects, { recursive: true, force: true });
    await mkdir(objects, { recursive: true });

    await rm(vanish, { recursive: true, force: true });

    const said: string[] = [];
    const attempt = createRepodir(
      { ...cfg, root: join(tmp, "repodirs-corrupt") },
      vanishSpec(),
      { warn: (m) => void said.push(m) },
      "0.1.0",
    );

    // 落ちる。かつ、直し方を言う
    expect(attempt).rejects.toThrow(/rm -rf/);

    // 「そのまま使う」とは言っていない (言った直後に死ぬくらいなら、言わない)
    expect(said.join("\n")).not.toContain("using the existing mirror as-is");
  });
});

describe("並行実行", () => {
  test("mirror がまだ無い repo に同時に rd new を撃っても、誰も落ちない", async () => {
    // 同じ repo に並列でエージェントを立てるのは、この道具の中心的な使い方そのもの。
    // path へ直接 clone すると、負けた側が destination path already exists で落ちる。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureMirror(cfg, spec())),
    );

    // 作れたのはちょうど 1 人。残りは勝者の mirror をそのまま使う
    expect(results.filter((r) => r.created)).toHaveLength(1);
    for (const r of results) {
      expect(r.path).toBe(mirrorPath(cfg, spec()));
      expect(await git(["rev-parse", "--verify", "refs/heads/main"], r.path)).toBeTruthy();
    }

    // 敗者の temp が残っていない
    const leftovers = [...new Bun.Glob("*.tmp-*").scanSync({ cwd: cfg.mirrorRoot, onlyFiles: false })];
    expect(leftovers).toBeEmpty();
  });

  test("既存 mirror に同時に rd new を撃っても、誰も落ちない (更新の競合は stale に落ちる)", async () => {
    const first = await ensureMirror(cfg, spec());
    await ageMirror(first.path, cfg.mirrorMaxAgeMs + 60_000);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureMirror(cfg, spec(), { refresh: true })),
    );

    // 更新できたか stale かは競合次第。決めているのは「誰も throw しない」こと
    for (const r of results) expect(r.updated || r.stale).toBe(true);
    expect(await git(["rev-parse", "--is-bare-repository"], first.path)).toBe("true");
  });

  test("origin の付け替えに失敗しても落とさず、古いまま使う (config のロック競合を想定)", async () => {
    // 並行実行時の .git/config ロック競合を、config を書けなくすることで決定的に再現する。
    // set-url は remote update と同じく remote に出るための下準備なので、同じ扱いに落ちる。
    const first = await ensureMirror(cfg, spec());
    await ageMirror(first.path, cfg.mirrorMaxAgeMs + 60_000);
    await chmod(join(first.path, "config"), 0o444);

    try {
      // protocol を変えて set-url を必ず走らせる
      const r = await ensureMirror(cfg, spec(), { protocol: "ssh" });

      expect(r.stale).toBe(true);
      expect(r.warnings.join("\n")).toContain("could not update the mirror");
    } finally {
      await chmod(join(first.path, "config"), 0o644);
    }
  });
});

describe("鮮度を確認していないことを、新鮮と偽らない", () => {
  test("--no-refresh は checked: false と実年齢を返す (呼び手が古さを表示できる)", async () => {
    const first = await ensureMirror(cfg, spec());
    await ageMirror(first.path, 7 * 86_400_000);

    const r = await ensureMirror(cfg, spec(), { refresh: false });

    expect(r.checked).toBe(false);
    expect(r.stale).toBe(false);
    expect(r.ageMs).toBeGreaterThan(6 * 86_400_000);
  });

  test("確認して新鮮だったときは checked: true (--no-refresh と区別できる)", async () => {
    await ensureMirror(cfg, spec());
    const r = await ensureMirror(cfg, spec());

    expect(r.checked).toBe(true);
    expect(r.ageMs).toBeLessThan(cfg.mirrorMaxAgeMs);
  });

  test("更新した直後の年齢は 0", async () => {
    await ensureMirror(cfg, spec());
    const r = await ensureMirror(cfg, spec(), { refresh: true });

    expect(r).toMatchObject({ updated: true, checked: true, ageMs: 0 });
  });
});
