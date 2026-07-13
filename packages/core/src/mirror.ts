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
import { cloneUrl, specToSlug, type Protocol, type RepoSpec } from "./repospec.ts";

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

/** mirror の最終 fetch からの経過 (ミリ秒)。時刻が取れなければ null。 */
async function age(path: string): Promise<number | null> {
  const fetched = await lastFetchedAt(path);
  return fetched ? Date.now() - fetched.getTime() : null;
}

export type EnsureMirrorResult = {
  path: string;
  created: boolean;
  updated: boolean;
  /** 更新すべきだったが失敗し、古い mirror をそのまま使っている */
  stale: boolean;
  /**
   * 鮮度を確認したか。--no-refresh のときだけ false になる。
   *
   * 「確認して新鮮だった」と「そもそも確認していない」を混ぜると、1 週間前の mirror が
   * 新鮮なものと同じ顔で出てくる。呼び手が両者を区別できるよう、別の値として持つ。
   */
  checked: boolean;
  /** 最終 fetch からの経過 (ミリ秒)。更新した直後は 0、時刻が取れなければ null。 */
  ageMs: number | null;
};

export type EnsureMirrorOptions = {
  /**
   * 鮮度チェックの上書き。
   *
   *   undefined … cfg.mirrorMaxAgeMs で判定する (既定)
   *   true      … 鮮度を問わず必ず remote update する (--refresh)
   *   false     … 鮮度チェックごと飛ばす (--no-refresh)
   */
  refresh?: boolean;
  protocol?: Protocol;
  /** 既定は stderr。テスト用の差し替え口 */
  warn?: (message: string) => void;
};

/**
 * 警告に出す失敗理由。GitError.message はコマンド行から始まるので、そのまま出すと
 * 「なぜ失敗したか」が読めない。git が stderr に書いた fatal / error の行を拾う。
 */
function failureReason(e: unknown): string {
  if (e instanceof GitError) {
    const lines = e.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.at(-1) ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** ミリ秒を人が読める粗い粒度にする (警告文用)。 */
function humanAge(ms: number): string {
  const units: [number, string][] = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"]];
  for (const [size, suffix] of units) {
    if (ms >= size) return `${Math.floor(ms / size)}${suffix}`;
  }
  return `${Math.floor(ms / 1000)}s`;
}

/**
 * mirror を用意する。無ければ作り、古ければ更新する。
 *
 * 新鮮さの閾値は cfg.mirrorMaxAgeMs。常駐 agent (ccxd) が背後で mirror を更新する構想は
 * あるが、それは ccxd 側の責務であり、ここは「単独で動かしたときに何が起きるか」だけを
 * 決める。ccxd が居ても居なくても、この関数の判断だけで正しい repodir が生える。
 *
 * 更新に失敗しても落とさない。オフラインでも repodir が作れることは設計上の売りなので、
 * 鮮度のために可用性を捨てない。古い mirror から repodir を作り、stderr で警告する。
 * 「少し古い作業コピー」は仕事の続行を妨げないが、「repodir が作れない」は妨げる。
 *
 * mirror がまだ無い場合だけは remote に届かないと何も作れないので、そこでの失敗は投げる。
 */
export async function ensureMirror(
  cfg: Config,
  spec: RepoSpec,
  opts: EnsureMirrorOptions = {},
): Promise<EnsureMirrorResult> {
  const path = mirrorPath(cfg, spec);
  const url = cloneUrl(spec, opts.protocol ?? cfg.protocol);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));

  if (!(await exists(path))) {
    const created = await cloneMirror(url, path);
    const ageMs = created ? 0 : await age(path);
    return { path, created, updated: false, stale: false, checked: true, ageMs };
  }

  const ageMs = await age(path);

  // --no-refresh は「mirror に一切触らない」ことが売りなので、ここで打ち切る。origin の
  // 追従 (syncOrigin) も remote に出るときにしか要らないので、この後ろに置いてある。
  // 鮮度は見ていないので checked: false。呼び手はこれを「新鮮」と混同してはいけない。
  if (opts.refresh === false) {
    return { path, created: false, updated: false, stale: false, checked: false, ageMs };
  }

  const needsUpdate = opts.refresh === true || ageMs === null || ageMs > cfg.mirrorMaxAgeMs;
  if (!needsUpdate) return { path, created: false, updated: false, stale: false, checked: true, ageMs };

  try {
    // 既存 mirror の origin は作られた時点の protocol のまま残る。protocol を切り替えても
    // fetch が旧 protocol のまま飛ぶと、設定した意味が無い (SSH のみのフォージなら失敗する)。
    //
    // set-url も fetch と同じく失敗しうる (並行実行時の .git/config のロック競合など) ので、
    // 更新一式をまとめて try で囲む。ここから先の失敗は全て「古いまま使う」に落とす。
    await syncOrigin(path, url);
    await git(["remote", "update", "--prune"], path);
    return { path, created: false, updated: true, stale: false, checked: true, ageMs: 0 };
  } catch (e) {
    const when = ageMs === null ? "unknown age" : `last fetched ${humanAge(ageMs)} ago`;
    warn(`ccx: warning: could not update the mirror (${when}): ${failureReason(e)}`);
    warn(`ccx: using the existing mirror as-is; the repodir may be behind ${specToSlug(spec)}`);
    return { path, created: false, updated: false, stale: true, checked: true, ageMs };
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
