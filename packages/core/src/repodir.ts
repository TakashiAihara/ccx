/**
 * repodir の生成。
 *
 * 同一 repo の独立した作業コピーを複数持つための仕組み。worktree と違い完全な clone
 * なので、同じブランチを 2 箇所で同時に checkout でき、submodule とも衝突せず、親
 * ディレクトリとの紐付きも無い。
 *
 * ディスクと時間のコストは bare mirror からの hardlink clone で回収する。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { newDirId } from "./dirid.ts";
import { defaultBranch, git, revParse } from "./git.ts";
import {
  detectCreatedBy,
  META_SCHEMA,
  writeMeta,
  writeState,
  type Goal,
  type PrIntent,
  type RepodirMeta,
} from "./meta.ts";
import { cloneUrl, type Protocol, type RepoSpec } from "./repospec.ts";
import { ensureMirror } from "./mirror.ts";

export type NewRepodirOptions = {
  initialTask?: string;
  /** 起点ブランチ。省略時は mirror の default branch */
  from?: string;
  goal?: Goal;
  pr?: PrIntent;
  agent?: string;
  model?: string;
  /**
   * mirror の鮮度チェックの上書き。
   *   未指定 = cfg.mirrorMaxAgeMs で判定 / true = 必ず更新 / false = チェックごと飛ばす
   */
  refresh?: boolean;
  /** clone / origin に使う protocol。省略時は cfg.protocol */
  protocol?: Protocol;
  /** mirror についての警告の出力先。既定は stderr */
  warn?: (message: string) => void;
  /** submodule を初期化する (既定 true) */
  recurseSubmodules?: boolean;
};

export type NewRepodirResult = {
  path: string;
  dirId: string;
  meta: RepodirMeta;
  mirror: {
    created: boolean;
    updated: boolean;
    stale: boolean;
    checked: boolean;
    ageMs: number | null;
  };
};

export async function createRepodir(
  cfg: Config,
  spec: RepoSpec,
  opts: NewRepodirOptions,
  version: string,
): Promise<NewRepodirResult> {
  const protocol = opts.protocol ?? cfg.protocol;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  const mirror = await ensureMirror(cfg, spec, { refresh: opts.refresh, protocol });

  const parent = join(cfg.root, spec.host, spec.owner, spec.repo);
  await mkdir(parent, { recursive: true });

  const branch = opts.from ?? (await defaultBranch(mirror.path));

  // dir-id はマシン内で一意だが、念のため衝突時は取り直す
  let dirId = newDirId();
  let path = join(parent, dirId);
  for (let i = 0; (await Bun.file(join(path, ".git", "HEAD")).exists()) && i < 5; i++) {
    dirId = newDirId();
    path = join(parent, dirId);
  }

  // hardlink clone。--no-checkout せず branch を直接指定する
  //
  // 更新に失敗した mirror を使っている場合、ここで初めて「その mirror が本当に使えるか」が
  // 分かる。壊れた object を踏めば落ちる。ensureMirror が警告を持ち帰るだけにしてあるのは、
  // この結果を見てから口を開くため。
  try {
    await git(["clone", "--quiet", "--branch", branch, mirror.path, path]);
  } catch (e) {
    if (!mirror.stale) throw e;
    throw new Error(
      [
        `could not create a repodir from the mirror at ${mirror.path}`,
        `the mirror could not be updated, and the copy on disk does not read back:`,
        `  ${e instanceof Error ? e.message.split("\n").find((l) => /^(fatal|error):/.test(l.trim())) ?? e.message.split("\n")[0] : String(e)}`,
        `remove it and ccx will clone it again: rm -rf ${mirror.path}`,
      ].join("\n"),
      { cause: e },
    );
  }

  // mirror から clone すると origin がローカル path になる。付け替えを忘れると
  // push が mirror に飛ぶので、ここは必須。
  await git(["remote", "set-url", "origin", cloneUrl(spec, protocol)], path);

  // submodule は origin を直した「後」に取る。相対 URL (../foo.git) は origin を基準に
  // 解決されるため、順序を逆にすると mirror のローカル path を基準に解決してしまう。
  //
  // mirror は superproject の object しか持たないので submodule 本体は network から取る。
  // --reference で mirror を参照させれば速いが alternates による結合が生まれ、repodir の
  // 疎結合という前提を壊すため採らない。
  if (opts.recurseSubmodules ?? true) {
    await git(["submodule", "update", "--init", "--recursive", "--quiet"], path);
  }

  const meta: RepodirMeta = {
    schema: META_SCHEMA,
    ...(opts.initialTask ? { initialTask: opts.initialTask } : {}),
    ...(opts.goal && Object.keys(opts.goal).length ? { goal: opts.goal } : {}),
    ...(opts.pr && Object.keys(opts.pr).length ? { pr: opts.pr } : {}),
    agent: opts.agent ?? cfg.defaults.agent,
    ...(opts.model ?? cfg.defaults.model ? { model: opts.model ?? cfg.defaults.model } : {}),
    baseBranch: branch,
    baseCommit: await revParse("HEAD", path),
    created: new Date().toISOString(),
    createdBy: detectCreatedBy(),
    ccxVersion: version,
  };

  await writeMeta(path, meta);
  await writeState(path, { desired: "stopped", done: null });

  // repodir が実際に生えた。ここまで来て初めて「古い mirror のまま続行した」と言える
  for (const w of mirror.warnings) warn(w);

  return {
    path,
    dirId,
    meta,
    mirror: {
      created: mirror.created,
      updated: mirror.updated,
      stale: mirror.stale,
      checked: mirror.checked,
      ageMs: mirror.ageMs,
    },
  };
}
