/**
 * repodir の走査と状態の導出。
 *
 * ccx.json / ccx.state に書いてあるのは「生成時の不変の事実」と「望まれる状態」だけ。
 * ブランチ・dirty・未 push・stash・session の生死は、そのつど git と Claude の状態
 * ディレクトリから導出する。複製すれば必ず同期ずれを起こすため。
 */

import { readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { dirIdToDate, isDirId } from "./dirid.ts";
import { git } from "./git.ts";
import {
  loadMeta,
  loadState,
  type MetaProblem,
  type RepodirMeta,
  type RepodirState,
} from "./meta.ts";
import type { RepoSpec } from "./repospec.ts";
import { claudeHome } from "./session-state.ts";

/** この時間だけ session の JSONL が更新されていなければ、生きていないとみなす */
export const SESSION_IDLE_MS = 15 * 60 * 1000;

export type GitState = {
  branch: string | null;
  dirty: boolean;
  /** upstream に無い commit の数。upstream 自体が無ければ、全 commit を数えない代わりに null */
  unpushed: number | null;
  hasUpstream: boolean;
  stashes: number;
};

export type SessionState = {
  active: boolean;
  lastActivity: Date | null;
  transcripts: number;
};

export type RepodirInfo = {
  path: string;
  dirId: string;
  spec: RepoSpec;
  created: Date;
  /** 検証を通ったメタデータ。通らなければ null。半端に読めた値は渡さない */
  meta: RepodirMeta | null;
  state: RepodirState | null;
  /**
   * ccx.json / ccx.state の検証で見つかった問題。空なら健全。
   *
   * 壊れた repodir を黙って飛ばすと、正体不明のディレクトリが残る。それは各 dir に
   * メタデータを持たせた理由そのものなので、読めなかったことを必ず持ち上げる。
   */
  problems: MetaProblem[];
  git: GitState;
  session: SessionState;
  /** cwd がこの repodir の中にあるプロセス (エージェントの抜けたシェル等)。消すと削除済みの dir に取り残される (#221) */
  processes: CwdProcess[];
};

export type CwdProcess = { pid: number; command: string };

/**
 * /proc/<pid>/cwd を全部読む。読めないもの (他ユーザー / 消えた) は飛ばす。/proc の無いホスト
 * (macOS) では空で、そこでは数えない。repodir の中から ccx を叩けば、そのシェルが中にいるので止まる。
 * shortcut: Linux の /proc だけ。macOS で要るなら lsof -d cwd で足す
 */
export async function cwdProcesses(procRoot = "/proc"): Promise<(CwdProcess & { cwd: string })[]> {
  let names: string[];
  try {
    names = (await readdir(procRoot)).filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  const out = await Promise.all(
    names.map(async (n) => {
      try {
        const cwd = await readlink(join(procRoot, n, "cwd"));
        const command = (await Bun.file(join(procRoot, n, "comm")).text().catch(() => "?")).trim();
        return { pid: Number(n), command, cwd };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((p) => p !== null);
}

/**
 * Claude Code の project ディレクトリ名。cwd の / . _ をすべて - に潰したもの。
 */
export function encodeCwd(path: string): string {
  return path.replace(/[/._]/g, "-");
}

/**
 * その cwd の session の transcript がある場所。CLAUDE_CONFIG_DIR (#232) と ~/.claude の両方を見る:
 * ccx を叩いた shell と session とで CLAUDE_CONFIG_DIR が違っても (片方だけに設定がある等)、見る範囲を
 * 以前 (~/.claude だけ) より狭めない。それ以外の config dir (cswap の別アカウント等) で動く session は
 * 見えない。gc でそれを守るのは cwd の process (/proc を読むので Linux だけ。macOS では守られない)
 */
export const defaultClaudeHomes = () => [...new Set([claudeHome(), join(homedir(), ".claude")])];

async function sessionState(path: string, idleMs: number, homes: string[]): Promise<SessionState> {
  const files: string[] = [];
  for (const dir of homes.map((home) => join(home, "projects", encodeCwd(path)))) {
    try {
      for (const n of await readdir(dir)) if (n.endsWith(".jsonl")) files.push(join(dir, n));
    } catch {
      // その config dir に、この cwd の session が無い
    }
  }

  let last: Date | null = null;
  for (const f of files) {
    const { mtime } = await Bun.file(f).stat();
    if (!last || mtime > last) last = mtime;
  }

  return {
    active: last !== null && Date.now() - last.getTime() < idleMs,
    lastActivity: last,
    transcripts: files.length,
  };
}

async function gitState(path: string): Promise<GitState> {
  const [branch, status, stash] = await Promise.all([
    git(["branch", "--show-current"], path).catch(() => ""),
    git(["status", "--porcelain"], path).catch(() => ""),
    git(["stash", "list"], path).catch(() => ""),
  ]);

  let unpushed: number | null = null;
  let hasUpstream = false;
  try {
    await git(["rev-parse", "--abbrev-ref", "@{upstream}"], path);
    hasUpstream = true;
    unpushed = Number(await git(["rev-list", "--count", "@{upstream}..HEAD"], path));
  } catch {
    // upstream が無い = 一度も push されていないブランチ。commit があるかは別に見る
    hasUpstream = false;
    try {
      const n = Number(await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], path));
      unpushed = n;
    } catch {
      unpushed = null;
    }
  }

  return {
    branch: branch || null,
    dirty: status.trim() !== "",
    unpushed,
    hasUpstream,
    stashes: stash.trim() === "" ? 0 : stash.trim().split("\n").length,
  };
}

async function readOne(
  path: string,
  spec: RepoSpec,
  dirId: string,
  idleMs: number,
  homes: string[],
  procs: (CwdProcess & { cwd: string })[],
): Promise<RepodirInfo> {
  const [meta, state, g, s, real] = await Promise.all([
    loadMeta(path),
    loadState(path),
    gitState(path),
    sessionState(path, idleMs, homes),
    realpath(path).catch(() => path),
  ]);

  return {
    path,
    dirId,
    spec,
    // 生成時刻は meta が正なら meta から、壊れていれば dir-id から導出する
    created: meta.value ? new Date(meta.value.created) : dirIdToDate(dirId),
    meta: meta.value,
    state: state.value,
    problems: [...meta.problems, ...state.problems],
    git: g,
    session: s,
    // /proc の cwd は実パス。root が symlink を通っていても一致させる
    processes: procs.filter((p) => p.cwd === real || p.cwd.startsWith(`${real}/`)).map(({ pid, command }) => ({ pid, command })),
  };
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== ".mirror")
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export type ScanOptions = {
  /** repo で絞る (host/owner/repo の部分一致) */
  filter?: string;
  idleMs?: number;
  /** テスト用。session の transcript を探す Claude の config dir (既定は defaultClaudeHomes) */
  claudeHomes?: string[];
  /** テスト用。cwd を読む /proc の場所 */
  procRoot?: string;
};

/** root 配下の repodir をすべて読む。<host>/<owner>/<repo>/<dir-id> の 4 階層。 */
export async function scanRepodirs(cfg: Config, opts: ScanOptions = {}): Promise<RepodirInfo[]> {
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const homes = opts.claudeHomes ?? defaultClaudeHomes();
  const found: Promise<RepodirInfo>[] = [];
  const procs = await cwdProcesses(opts.procRoot);

  for (const host of await subdirs(cfg.root)) {
    for (const owner of await subdirs(join(cfg.root, host))) {
      for (const repo of await subdirs(join(cfg.root, host, owner))) {
        const slug = `${host}/${owner}/${repo}`;
        if (opts.filter && !slug.includes(opts.filter)) continue;

        for (const dirId of await subdirs(join(cfg.root, host, owner, repo))) {
          if (!isDirId(dirId)) continue;
          const path = join(cfg.root, host, owner, repo, dirId);
          found.push(readOne(path, { host, owner, repo }, dirId, idleMs, homes, procs));
        }
      }
    }
  }

  const all = await Promise.all(found);
  return all.sort((a, b) => a.created.getTime() - b.created.getTime());
}
