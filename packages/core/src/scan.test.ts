/**
 * 走査の巻き添え耐性。
 *
 * 壊れた repodir が 1 個あるだけで ls 全体が落ちる / 健全な repodir まで消える、という
 * のが issue #13 が恐れた失敗そのもの。「壊れているものを黙って飛ばさない」ことと、
 * 「壊れているものが他を巻き添えにしない」ことは両立していなければならない。
 *
 * ここは検証ロジックの単体ではなく、実物のディレクトリを scan して固定する。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { git } from "./git.ts";
import { META_SCHEMA, metaPath, statePath } from "./meta.ts";
import { createRepodir } from "./repodir.ts";
import { parseRepoSpec } from "./repospec.ts";
import { scanRepodirs, type RepodirInfo } from "./scan.ts";

const REMOTE = "https://github.com/test-owner/demo.git";

let tmp: string;
let cfg: Config;
let saved: string | undefined;

const spec = () => parseRepoSpec("test-owner/demo", { defaultHost: "github.com" });
const find = (infos: RepodirInfo[], path: string) => infos.find((i) => i.path === path)!;
const messages = (i: RepodirInfo) => i.problems.map((p) => p.message);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-scan-"));
  const source = join(tmp, "source.git");

  const work = join(tmp, "work");
  await git(["init", "--quiet", "--initial-branch", "main", work]);
  await git(["config", "user.email", "t@example.com"], work);
  await git(["config", "user.name", "t"], work);
  await Bun.write(join(work, "README.md"), "# demo\n");
  await git(["add", "README.md"], work);
  await git(["commit", "--quiet", "-m", "init"], work);
  await git(["clone", "--quiet", "--bare", work, source]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], source);

  const gitconfig = join(tmp, "gitconfig");
  await Bun.write(gitconfig, `[url "file://${source}"]\n\tinsteadOf = ${REMOTE}\n`);
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

describe("壊れた repodir は他を巻き添えにしない", () => {
  test("健全なものと壊れたものが混在しても、scan は落ちず全部返す", async () => {
    const healthy = await createRepodir(cfg, spec(), { initialTask: "still fine" }, "0.1.0");

    // JSON として壊れている
    const truncated = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(metaPath(truncated.path), '{ "schema": 1, "agent"');

    // メタデータごと消えた = 正体不明のディレクトリ
    const orphan = await createRepodir(cfg, spec(), {}, "0.1.0");
    await unlink(metaPath(orphan.path));
    await unlink(statePath(orphan.path));

    // 未来の ccx が書いた
    const future = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(
      metaPath(future.path),
      JSON.stringify({ schema: META_SCHEMA + 1, agent: "claude" }),
    );

    // 空ファイル (書き込みが途中で死んだ跡)
    const empty = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(metaPath(empty.path), "");

    // reject しないこと。1 個の破損で ls 全体が死ぬのが最悪の失敗
    const infos = await scanRepodirs(cfg);
    const paths = infos.map((i) => i.path);
    for (const r of [healthy, truncated, orphan, future, empty]) {
      expect(paths).toContain(r.path);
    }

    // 健全なものは破損の隣にいても無傷
    const h = find(infos, healthy.path);
    expect(h.problems).toEqual([]);
    expect(h.meta?.initialTask).toBe("still fine");
    expect(h.state?.desired).toBe("stopped");

    // 壊れたものは、壊れ方ごとに理由が言える
    const t = find(infos, truncated.path);
    expect(t.meta).toBeNull();
    expect(t.problems[0]?.kind).toBe("unreadable");

    const o = find(infos, orphan.path);
    expect(o.meta).toBeNull();
    expect(o.state).toBeNull();
    expect(messages(o)).toEqual(["ccx.json: is missing", "ccx.state: is missing"]);

    const f = find(infos, future.path);
    expect(f.meta).toBeNull();
    expect(f.problems[0]?.kind).toBe("schema-newer");

    const e = find(infos, empty.path);
    expect(e.meta).toBeNull();
    expect(e.problems[0]?.kind).toBe("unreadable");
  });

  test("meta が読めなくても、生成時刻は dir-id から導出できる", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(metaPath(r.path), "not json at all");

    const info = find(await scanRepodirs(cfg), r.path);

    // 正体不明にはしない。いつ生まれたかは id が知っている
    expect(info.meta).toBeNull();
    expect(Number.isNaN(info.created.getTime())).toBe(false);
    expect(Math.abs(Date.now() - info.created.getTime())).toBeLessThan(60_000);
  });

  test("meta が壊れていても git の状態は読む (作業の有無は失われない)", async () => {
    const r = await createRepodir(cfg, spec(), {}, "0.1.0");
    await Bun.write(metaPath(r.path), "{");
    await Bun.write(join(r.path, "work.txt"), "uncommitted work\n");

    const info = find(await scanRepodirs(cfg), r.path);

    expect(info.problems).not.toEqual([]);
    expect(info.git.branch).toBe("main");
    expect(info.git.dirty).toBe(true);
  });
});
