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
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { git } from "./git.ts";
import { ensureMirror, mirrorPath } from "./mirror.ts";
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

/** 警告の宛先を捕まえる */
const capture = () => {
  const lines: string[] = [];
  return { lines, warn: (m: string) => void lines.push(m) };
};

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

    const c = capture();
    const r = await ensureMirror(cfg, vanishSpec(), { warn: c.warn });

    expect(r).toMatchObject({ created: false, updated: false, stale: true });
    // mirror は壊れておらず、object も残っている (repodir はここから生やせる)
    expect(await git(["rev-parse", "--is-bare-repository"], r.path)).toBe("true");
    expect(await git(["rev-parse", "--verify", "refs/heads/main"], r.path)).toBeTruthy();
  });

  test("古いまま使うときは警告する (黙って古い repodir を生やさない)", async () => {
    await mirrorThenGoOffline(3 * 3_600_000);

    const c = capture();
    await ensureMirror(cfg, vanishSpec(), { warn: c.warn });

    const out = c.lines.join("\n");
    expect(out).toContain("could not update the mirror");
    expect(out).toContain("3h");
    expect(out).toContain("test-owner/vanish");
  });

  test("refresh: true でも、更新に失敗したら落とさず警告する", async () => {
    await mirrorThenGoOffline(0);

    const c = capture();
    const r = await ensureMirror(cfg, vanishSpec(), { refresh: true, warn: c.warn });

    expect(r.stale).toBe(true);
    expect(c.lines.join("\n")).toContain("could not update the mirror");
  });

  test("refresh: false ならオフラインでも警告すら出ない (remote に触らないため)", async () => {
    await mirrorThenGoOffline(cfg.mirrorMaxAgeMs * 10);

    const c = capture();
    const r = await ensureMirror(cfg, vanishSpec(), { refresh: false, warn: c.warn });

    expect(r).toMatchObject({ updated: false, stale: false });
    expect(c.lines).toBeEmpty();
  });

  test("mirror がまだ無いときの失敗は投げる (古い mirror すら無いので続行できない)", async () => {
    const missing = parseRepoSpec("test-owner/missing", { defaultHost: "github.com" });

    expect(ensureMirror(cfg, missing)).rejects.toThrow();
  });
});
