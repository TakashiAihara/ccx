/**
 * CLI を実プロセスとして起動する end-to-end テスト。
 *
 * core 側の単体テストでは「ensureMirror が stale を返す」までしか見えない。ここで固定したいのは
 * その先、ユーザーが実際に受け取るもの:
 *
 *   - exit code (オフラインでも 0。cd "$(ccx rd new ...)" が壊れないこと)
 *   - stdout が path だけであること (付帯情報が混ざると上の使い方が壊れる)
 *   - stderr の表示が mirror の状態を偽らないこと
 *
 * network には出ない。forge は insteadOf でローカルの bare repo に読み替える。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
const REMOTE = "https://github.com/acme/demo.git";

let tmp: string;
let forge: string;
let root: string;
let gitconfig: string;

type Run = { code: number; stdout: string; stderr: string };

/** ccx を実プロセスで起動する。GIT_CONFIG_GLOBAL で forge をローカルに読み替える。 */
async function ccx(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: gitconfig,
      CCX_ROOT: root,
      CCX_DEFAULT_HOST: "github.com",
      ...env,
    },
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

const mirror = () => join(root, ".mirror", "github.com", "acme", "demo.git");

/** mirror の最終 fetch 時刻を過去にずらす */
async function ageMirror(ms: number): Promise<void> {
  const t = new Date(Date.now() - ms);
  for (const f of ["FETCH_HEAD", "packed-refs", "HEAD"]) {
    await utimes(join(mirror(), f), t, t).catch(() => {});
  }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-cli-"));
  forge = join(tmp, "forge.git");
  gitconfig = join(tmp, "gitconfig");

  const work = join(tmp, "work");
  const git = async (args: string[], cwd?: string) => {
    const proc = Bun.spawn(cwd ? ["git", "-C", cwd, ...args] : ["git", ...args], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };

  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["clone", "--quiet", "--bare", work, forge]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], forge);

  await Bun.write(gitconfig, `[url "file://${forge}"]\n\tinsteadOf = ${REMOTE}\n`);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmp, "root-"));
});

describe("ccx repodir new", () => {
  test("stdout は repodir の path だけ (cd \"$(ccx rd new ...)\" が成立する)", async () => {
    const r = await ccx(["rd", "new", "acme/demo"]);

    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toHaveLength(1);
    expect(await Bun.file(join(r.stdout, "README.md")).exists()).toBe(true);
    expect(r.stderr).toContain("mirror  created");
  });

  test("オフラインでも repodir は作れる (exit 0 + 警告 + stale 表示)", async () => {
    await ccx(["rd", "new", "acme/demo"]);
    await ageMirror(3 * 3_600_000);
    await rm(forge, { recursive: true, force: true });

    try {
      const r = await ccx(["rd", "new", "acme/demo"]);

      // 落ちないこと。これがこの機能の中核保証
      expect(r.code).toBe(0);
      expect(await Bun.file(join(r.stdout, "README.md")).exists()).toBe(true);

      expect(r.stderr).toContain("could not update the mirror");
      expect(r.stderr).toContain("mirror  stale");
      // 黙って新鮮なふりをしない
      expect(r.stderr).not.toContain("mirror  cached");
    } finally {
      const proc = Bun.spawn(["git", "clone", "--quiet", "--bare", join(tmp, "work"), forge], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    }
  });

  test("--no-refresh は古さを隠さない (cached ではなく unchecked + 年齢)", async () => {
    await ccx(["rd", "new", "acme/demo"]);
    await ageMirror(7 * 86_400_000);

    const r = await ccx(["rd", "new", "acme/demo", "--no-refresh"]);

    expect(r.code).toBe(0);
    expect(r.stderr).toContain("mirror  unchecked");
    expect(r.stderr).toContain("7d ago");
    expect(r.stderr).not.toContain("cached");
  });

  test("鮮度を確認して新鮮だったときは cached と年齢を出す", async () => {
    await ccx(["rd", "new", "acme/demo"]);

    const r = await ccx(["rd", "new", "acme/demo"]);
    expect(r.stderr).toContain("mirror  cached");
  });

  test("--refresh と --no-refresh を両方渡すと後勝ち (commander の解決に従う)", async () => {
    await ccx(["rd", "new", "acme/demo"]);
    await ageMirror(7 * 86_400_000);

    const noRefreshWins = await ccx(["rd", "new", "acme/demo", "--refresh", "--no-refresh"]);
    expect(noRefreshWins.stderr).toContain("mirror  unchecked");

    const refreshWins = await ccx(["rd", "new", "acme/demo", "--no-refresh", "--refresh"]);
    expect(refreshWins.stderr).toContain("mirror  updated");
  });

  test("--protocol の値が不正なら、理由を添えて exit 1", async () => {
    const r = await ccx(["rd", "new", "acme/demo", "--protocol", "git"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("invalid protocol");
  });

  test("mirror がまだ無い repo にオフラインで挑むと exit 1 (古い mirror すら無い)", async () => {
    const r = await ccx(["rd", "new", "acme/absent"]);

    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
  });
});
