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
import { cloneUrl, type Protocol, type RepoSpec } from "./repospec.ts";

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

/**
 * mirror の origin を url に合わせる。既に一致していれば何もしない。
 *
 * origin が無い mirror に対して `git remote set-url` は使えない。remote を作る機能は無く、
 * "No such remote 'origin'" で終了コード 2 を返すだけで、mirror は origin 不在のまま残る。
 * その状態では以降の remote update も通らないので、無ければ設定を直接書いて作り直す。
 *
 * remote add ではなく config を直接書くのは、bare mirror の origin が普通の remote と違う
 * ためで、mirror が要求する refspec (+refs/*:refs/*) と mirror フラグを remote add は与えない。
 * clone --mirror が書くのと同じ 3 つを、同じ形で書く。
 */
async function syncOrigin(path: string, url: string): Promise<void> {
  let current: string | null = null;
  try {
    // remote get-url は insteadOf の書き換えを適用して返すので、保存値そのものを読む
    current = await git(["config", "--get", "remote.origin.url"], path);
  } catch {
    // origin 不在。下で作り直す
  }

  if (current === url) return;

  if (current === null) {
    await git(["config", "remote.origin.url", url], path);
    await git(["config", "remote.origin.fetch", "+refs/*:refs/*"], path);
    await git(["config", "--bool", "remote.origin.mirror", "true"], path);
    return;
  }

  await git(["remote", "set-url", "origin", url], path);
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
  opts: { force?: boolean; protocol?: Protocol } = {},
): Promise<EnsureMirrorResult> {
  const path = mirrorPath(cfg, spec);
  const url = cloneUrl(spec, opts.protocol ?? cfg.protocol);

  if (!(await exists(path))) {
    await git(["clone", "--mirror", "--quiet", url, path]);
    return { path, created: true, updated: false };
  }

  // 既存 mirror の origin は作られた時点の protocol のまま残る。protocol を切り替えても
  // fetch が旧 protocol のまま飛ぶと、設定した意味が無い (SSH のみのフォージなら失敗する)。
  await syncOrigin(path, url);

  const fetched = await lastFetchedAt(path);
  const stale = opts.force || !fetched || Date.now() - fetched.getTime() > cfg.mirrorMaxAgeMs;
  if (!stale) return { path, created: false, updated: false };

  await git(["remote", "update", "--prune"], path);
  return { path, created: false, updated: true };
}
