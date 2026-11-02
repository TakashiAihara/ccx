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
import { git, gitBare, GitError } from "./git.ts";
import { cloneUrl, explicitCloneUrl, type Protocol, type RepoSpec } from "./repospec.ts";

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
 * mirror の origin の url を合わせる。refspec と mirror フラグは repairMirrorConfig が持つ。
 *
 * origin が無い mirror に対して `git remote set-url` は使えない。remote を作る機能は無く、
 * "No such remote 'origin'" で終了コード 2 を返すだけで、mirror は origin 不在のまま残る。
 * 失敗した clone の後始末や手作業の復旧で origin が消えていることがあるので、無ければ作る。
 *
 * `git remote add` ではなく config を直接書く。`remote add --mirror=fetch` は refspec も書くが
 * mirror フラグは書かない。refspec と mirror フラグは repairMirrorConfig がまとめて揃えるので、
 * ここでは url だけを書く。
 */
async function syncOriginUrl(path: string, current: string | null, url: string): Promise<void> {
  if (current === null) {
    await gitBare(["config", "remote.origin.url", url], path);
  } else if (current !== url) {
    await gitBare(["remote", "set-url", "origin", url], path);
  }
}

const MIRROR_REFSPEC = "+refs/*:refs/*";

/** origin の fetch refspec の全行と mirror フラグ (bool として読んだ値)。キーが無ければ [] / null */
async function readMirrorConfig(path: string): Promise<{ refspecs: string[]; flag: string | null }> {
  let refspecs: string[] = [];
  try {
    refspecs = (await gitBare(["config", "--get-all", "remote.origin.fetch"], path)).split("\n");
  } catch (e) {
    // 1 は「キーが無い」。壊れた config (128) まで「無い」と読んで上書きしない
    if (!(e instanceof GitError) || e.code !== 1) throw e;
  }

  let flag: string | null = null;
  try {
    flag = await gitBare(["config", "--get", "--type=bool", "remote.origin.mirror"], path);
  } catch (e) {
    if (!(e instanceof GitError) || e.code !== 1) throw e;
  }

  return { refspecs, flag };
}

/**
 * origin の refspec と mirror フラグを揃える。url は触らない。
 *
 * 復旧が url の書き込み直後に中断されると、url だけが合って refspec と mirror フラグが無い
 * mirror が残る。url だけを見て済みと判定すると二度と直らないので、ここで別に確かめる。
 * refspec は複数行ありうる (`--get` は最後の 1 行しか返さない) ので、全行を読んで
 * mirror の refspec が無いときだけ足す。利用者が足した行は消さない。
 */
async function repairMirrorConfig(path: string): Promise<void> {
  const { refspecs, flag } = await readMirrorConfig(path);

  if (!refspecs.includes(MIRROR_REFSPEC)) {
    // 並行する修復が同じ行を足して重複させないよう、一致する行があれば 1 行に畳み、無ければ足す
    await gitBare(["config", "--replace-all", "remote.origin.fetch", MIRROR_REFSPEC, "^\\+refs/\\*:refs/\\*$"], path);
  }

  if (flag !== "true") {
    await gitBare(["config", "--bool", "remote.origin.mirror", "true"], path);
  }
}

export type EnsureMirrorResult = {
  path: string;
  created: boolean;
  updated: boolean;
  /** mirror の origin (repodir の origin にもこれを使う) */
  origin: string;
};

/**
 * mirror を用意する。無ければ作り、古ければ更新する。
 *
 * 新鮮さの閾値は cfg.mirrorMaxAgeMs。常駐 agent (ccx-agent) が定期的に更新する運用でも、
 * ここで閾値チェックを行うことで単独動作時に古い clone を生やさない。
 */
export async function ensureMirror(
  cfg: Config,
  spec: RepoSpec,
  /**
   * protocol: 明示されたときだけ渡す (無ければ cfg.protocol)。url: 組み立てでは表せない clone URL
   * (http / ポート付き。explicitCloneUrl)。どちらかが明示されたら、既存の origin もそれに付け替える
   */
  opts: { force?: boolean; protocol?: Protocol; url?: string; warn?: (message: string) => void } = {},
): Promise<EnsureMirrorResult> {
  const path = mirrorPath(cfg, spec);
  const url = opts.url ?? cloneUrl(spec, opts.protocol ?? cfg.protocol);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  if (!(await exists(path))) {
    const created = await cloneMirror(url, path);
    return { path, created, updated: false, origin: (await storedOrigin(path)) ?? url };
  }

  // 既存 mirror の origin は作られた時点の protocol のまま残る。protocol を切り替えても
  // fetch が旧 protocol のまま飛ぶと、設定した意味が無い (SSH のみのフォージなら失敗する)。
  // ただし初回に明示した http / ポート付きの URL は、設定の protocol では組み立てられない。
  // それが origin の唯一の記録なので、明示が無い限り付け替えない (#215)。
  //
  // origin の付け替えは fetch の下準備でしかない。並行実行で .git/config のロックを
  // 取り損ねたときに、それだけで repodir の生成そのものを諦めるのは割に合わない。失敗しても
  // 警告に留めて進み、fetch は (古い protocol の origin で) 続行する。refspec と mirror フラグの
  // 修復も同じく警告に留めるが、fetch の前に読み直して揃っていなければ止める (下の throw)。
  const current = await storedOrigin(path);
  const keep = !opts.url && !opts.protocol && current !== null && explicitCloneUrl(current) !== undefined;
  // repodir の origin はこちら。mirror の付け替えに失敗しても、求められた URL を repodir には付ける
  const origin = keep ? current : url;
  const firstLine = (e: unknown): string => (e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e));

  if (!keep) {
    try {
      await syncOriginUrl(path, current, url);
    } catch (e) {
      warn(`ccx: warning: could not point the mirror at ${url}: ${firstLine(e)}`);
    }
  }

  // 明示 URL の origin は付け替えないが、refspec と mirror フラグの欠けは直す
  let repairFailure: string | null = null;
  try {
    await repairMirrorConfig(path);
  } catch (e) {
    repairFailure = firstLine(e);
    warn(`ccx: warning: could not update the mirror's origin config (${origin}): ${repairFailure}`);
  }

  const fetched = await lastFetchedAt(path);
  const stale = opts.force || !fetched || Date.now() - fetched.getTime() > cfg.mirrorMaxAgeMs;
  if (!stale) return { path, created: false, updated: false, origin };

  // 修復の書き込みが失敗しても、並行する修復が先に書き終えていれば揃っている。それなら進む。
  // 揃っていないまま remote update すると refspec の無い fetch が何も取らずに成功し、
  // 古い mirror を「更新した」と返してしまう (#77)。mirror フラグは fetch には効かないが、
  // clone --mirror が作るのと同じ形でない mirror を更新済みとは扱わない
  if (repairFailure !== null) {
    const { refspecs, flag } = await readMirrorConfig(path);
    if (!refspecs.includes(MIRROR_REFSPEC) || flag !== "true") {
      throw new Error(`ccx: the mirror's origin config is incomplete (${path}); not updating it: ${repairFailure}`);
    }
  }

  await gitBare(["remote", "update", "--prune"], path);
  return { path, created: false, updated: true, origin };
}

/** 保存されている origin の URL (insteadOf を通さない)。無ければ null。壊れた config は投げる */
async function storedOrigin(path: string): Promise<string | null> {
  try {
    return await gitBare(["config", "--get", "remote.origin.url"], path);
  } catch (e) {
    if (e instanceof GitError && e.code === 1) return null;
    throw e;
  }
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
