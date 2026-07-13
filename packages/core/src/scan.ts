/**
 * repodir の走査と状態の導出。
 *
 * ccx.json / ccx.state に書いてあるのは「生成時の不変の事実」と「望まれる状態」だけ。
 * ブランチ・dirty・未 push・stash・session の生死は、そのつど git と Claude の状態
 * ディレクトリから導出する。複製すれば必ず同期ずれを起こすため。
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { dirIdToDate, isDirId } from "./dirid.ts";
import { git } from "./git.ts";
import { readMeta, readState, type RepodirMeta, type RepodirState } from "./meta.ts";
import type { RepoSpec } from "./repospec.ts";

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
  meta: RepodirMeta | null;
  state: RepodirState | null;
  /** ccx.json が壊れている / 読めない場合の理由。壊れていても黙って飛ばさない */
  metaError: string | null;
  git: GitState;
  session: SessionState;
};

/**
 * Claude Code の project ディレクトリ名。cwd の / . _ をすべて - に潰したもの。
 */
export function encodeCwd(path: string): string {
  return path.replace(/[/._]/g, "-");
}

export function claudeProjectDir(path: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(path));
}

async function sessionState(path: string, idleMs: number): Promise<SessionState> {
  const dir = claudeProjectDir(path);

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { active: false, lastActivity: null, transcripts: 0 };
  }

  let last: Date | null = null;
  for (const n of names) {
    const { mtime } = await Bun.file(join(dir, n)).stat();
    if (!last || mtime > last) last = mtime;
  }

  return {
    active: last !== null && Date.now() - last.getTime() < idleMs,
    lastActivity: last,
    transcripts: names.length,
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
): Promise<RepodirInfo> {
  let meta: RepodirMeta | null = null;
  let metaError: string | null = null;
  try {
    meta = await readMeta(path);
    if (meta && typeof meta.schema !== "number") {
      metaError = "ccx.json has no schema";
      meta = null;
    }
  } catch (e) {
    metaError = `ccx.json is unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }

  let state: RepodirState | null = null;
  try {
    state = await readState(path);
  } catch {
    // state が壊れていても致命ではない。desired 不明として扱う
  }

  const [g, s] = await Promise.all([gitState(path), sessionState(path, idleMs)]);

  return {
    path,
    dirId,
    spec,
    created: meta?.created ? new Date(meta.created) : dirIdToDate(dirId),
    meta,
    state,
    metaError,
    git: g,
    session: s,
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
};

/** root 配下の repodir をすべて読む。<host>/<owner>/<repo>/<dir-id> の 4 階層。 */
export async function scanRepodirs(cfg: Config, opts: ScanOptions = {}): Promise<RepodirInfo[]> {
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const found: Promise<RepodirInfo>[] = [];

  for (const host of await subdirs(cfg.root)) {
    for (const owner of await subdirs(join(cfg.root, host))) {
      for (const repo of await subdirs(join(cfg.root, host, owner))) {
        const slug = `${host}/${owner}/${repo}`;
        if (opts.filter && !slug.includes(opts.filter)) continue;

        for (const dirId of await subdirs(join(cfg.root, host, owner, repo))) {
          if (!isDirId(dirId)) continue;
          const path = join(cfg.root, host, owner, repo, dirId);
          found.push(readOne(path, { host, owner, repo }, dirId, idleMs));
        }
      }
    }
  }

  const all = await Promise.all(found);
  return all.sort((a, b) => a.created.getTime() - b.created.getTime());
}
