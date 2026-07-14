/**
 * bare mirror。repodir の hardlink 供給元。
 *
 * checkout されないので dirty にならず、repack しても安全。
 * repodir は `git clone <mirror path>` で生やす。同一ファイルシステム上なら
 * .git の pack が hardlink 共有され、ディスク消費が実質ゼロになる。
 */

import { dirname, join } from "node:path";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { Config } from "./config.ts";
import { git, GitError } from "./git.ts";
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
  } catch (e) {
    // git config --get は「キーが無い」を終了コード 1 で表す。壊れた config (128) や他の失敗まで
    // 「origin が無い」と解釈すると、読めなかった設定を黙って上書きしてしまう。1 だけを握る。
    if (!(e instanceof GitError) || e.code !== 1) throw e;
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
  opts: { force?: boolean; protocol?: Protocol; warn?: (message: string) => void } = {},
): Promise<EnsureMirrorResult> {
  const path = mirrorPath(cfg, spec);
  const url = cloneUrl(spec, opts.protocol ?? cfg.protocol);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  if (!(await exists(path))) {
    const created = await cloneMirror(url, path);
    return { path, created, updated: false };
  }

  // 既存 mirror の origin は作られた時点の protocol のまま残る。protocol を切り替えても
  // fetch が旧 protocol のまま飛ぶと、設定した意味が無い (SSH のみのフォージなら失敗する)。
  //
  // ただし origin の付け替えは fetch の下準備でしかない。並行実行で .git/config のロックを
  // 取り損ねたときに、それだけで repodir の生成そのものを諦めるのは割に合わない。失敗しても
  // 警告に留めて進み、fetch は (古い protocol の origin で) 続行する。
  try {
    await syncOrigin(path, url);
  } catch (e) {
    const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
    warn(`ccx: warning: could not point the mirror at ${url}: ${reason}`);
  }

  const fetched = await lastFetchedAt(path);
  const stale = opts.force || !fetched || Date.now() - fetched.getTime() > cfg.mirrorMaxAgeMs;
  if (!stale) return { path, created: false, updated: false };

  await git(["remote", "update", "--prune"], path);
  return { path, created: false, updated: true };
}

/**
 * mirror を作る。作れたら true、他のプロセスに先を越されていたら false。
 *
 * 同じ repo に対して rd new を同時に 2 本走らせるのは、並列エージェントを立てるという
 * この道具の中心的な使い方そのもの。path へ直接 clone すると、負けた側が
 * "destination path already exists" で落ちる (5 並列で 2 本が exit 1 になることを実測)。
 *
 * lock file は置かない (プロセスが死ぬと残り、次回以降を巻き添えにする)。代わりに temp へ
 * clone してから rename で差し込む。同一ファイルシステム上の rename は atomic なので、
 * 勝者がひとつだけ残る。負けた側は自分の temp を捨てて、勝者の mirror をそのまま使う。
 * 二重に clone する分の無駄はあるが、これは「同じ repo の mirror がまだ無い」初回だけ。
 */
async function cloneMirror(url: string, path: string): Promise<boolean> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true });
  await git(["clone", "--mirror", "--quiet", url, tmp]);

  try {
    await rename(tmp, path);
    return true;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    // 先を越されただけなら、相手の mirror を使えばよい。それ以外は本物の失敗なので投げる。
    if (await exists(path)) return false;
    throw e;
  }
}
