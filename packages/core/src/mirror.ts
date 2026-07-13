/**
 * bare mirror。repodir の hardlink 供給元。
 *
 * checkout されないので dirty にならず、repack しても安全。
 * repodir は `git clone <mirror path>` で生やす。同一ファイルシステム上なら
 * .git の pack が hardlink 共有され、ディスク消費が実質ゼロになる。
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";

import type { Config } from "./config.ts";
import { git } from "./git.ts";
import { cloneUrl, type RepoSpec } from "./repospec.ts";

export function mirrorPath(cfg: Config, spec: RepoSpec): string {
  return join(cfg.mirrorRoot, spec.host, spec.owner, `${spec.repo}.git`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** mirror の最終 fetch 時刻。無ければ null。 */
async function lastFetchedAt(path: string): Promise<Date | null> {
  for (const f of ["FETCH_HEAD", "packed-refs", "HEAD"]) {
    try {
      return (await stat(join(path, f))).mtime;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

export type EnsureMirrorResult = {
  path: string;
  created: boolean;
  updated: boolean;
};

/**
 * mirror を用意する。無ければ作り、古ければ更新する。
 *
 * 新鮮さの閾値は cfg.mirrorMaxAgeMs。常駐 agent (ccxd) が定期的に更新する運用でも、
 * ここで閾値チェックを行うことで単独動作時に古い clone を生やさない。
 */
export async function ensureMirror(
  cfg: Config,
  spec: RepoSpec,
  opts: { force?: boolean } = {},
): Promise<EnsureMirrorResult> {
  const path = mirrorPath(cfg, spec);

  if (!(await exists(path))) {
    await git(["clone", "--mirror", "--quiet", cloneUrl(spec), path]);
    return { path, created: true, updated: false };
  }

  const fetched = await lastFetchedAt(path);
  const stale = opts.force || !fetched || Date.now() - fetched.getTime() > cfg.mirrorMaxAgeMs;
  if (!stale) return { path, created: false, updated: false };

  await git(["remote", "update", "--prune"], path);
  return { path, created: false, updated: true };
}
