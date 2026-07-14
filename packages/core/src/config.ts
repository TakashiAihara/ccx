/**
 * 設定。個人環境の事情を焼き込まないための唯一の窓口。
 *
 * 解決の優先順位 (ghq に倣う):
 *
 *   1. 環境変数            CCX_ROOT / CCX_DEFAULT_OWNER / ...
 *   2. git config          ccx.root / ccx.defaultOwner / ...
 *   3. 設定ファイル        ~/.config/ccx/config.toml
 *   4. 既定値
 *
 * 環境変数が最優先なのは、shell rc で一時的に切り替えたいという用途が実在するため
 * (ghq の GHQ_ROOT と同じ扱い)。git config を挟むのは、リポジトリ管理ツールの設定を
 * git の設定体系に寄せたほうが置き場所を覚えずに済むため。
 *
 * どれも無くても動く。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { parseProtocol, type Protocol } from "./repospec.ts";

export type Config = {
  root: string;
  mirrorRoot: string;
  defaultHost: string;
  defaultOwner?: string;
  /** mirror の clone と repodir の origin に使う protocol */
  protocol: Protocol;
  /** これより古い mirror は repodir 生成前に remote update する (ミリ秒) */
  mirrorMaxAgeMs: number;
  defaults: {
    agent: string;
    model?: string;
  };
  /** 未設定なら hub 無し = ローカル単独動作 */
  hub?: { url: string };
};

const DEFAULT_MIRROR_MAX_AGE_MS = 10 * 60 * 1000;

export function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** "10m" / "30s" / "2h" / 数値(ms) を ms に変換する。 */
export function parseDuration(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") throw new Error(`invalid duration: ${String(v)}`);

  const m = v.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) throw new Error(`invalid duration: ${v}`);

  const n = Number(m[1]);
  switch (m[2] ?? "ms") {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: throw new Error(`invalid duration: ${v}`);
  }
}

export function configPath(env = process.env): string {
  if (env.CCX_CONFIG) return env.CCX_CONFIG;
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "ccx", "config.toml");
}

export function defaultConfig(): Config {
  const root = join(homedir(), ".repodirs");
  return {
    root,
    mirrorRoot: join(root, ".mirror"),
    defaultHost: "github.com",
    protocol: "https",
    mirrorMaxAgeMs: DEFAULT_MIRROR_MAX_AGE_MS,
    defaults: { agent: "claude" },
  };
}

/** `git config --get <key>`。未設定なら null。git が無くても落ちない。 */
export async function gitConfig(key: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "config", "--get", key], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 && out.trim() ? out.trim() : null;
  } catch {
    return null;
  }
}

type Sources = {
  env: Record<string, string | undefined>;
  file: Record<string, unknown>;
  git: (key: string) => Promise<string | null>;
};

/** 環境変数 → git config → ファイル の順に最初に見つかった値を返す。 */
async function pick(
  s: Sources,
  envKey: string,
  gitKey: string,
  fileKey: string,
): Promise<string | null> {
  const fromEnv = s.env[envKey];
  if (fromEnv) return fromEnv;

  const fromGit = await s.git(gitKey);
  if (fromGit) return fromGit;

  const fromFile = s.file[fileKey];
  return fromFile === undefined || fromFile === null ? null : String(fromFile);
}

export type LoadOptions = {
  env?: Record<string, string | undefined>;
  /** テスト用の差し替え口 */
  git?: (key: string) => Promise<string | null>;
};

export async function loadConfig(opts: LoadOptions = {}): Promise<Config> {
  const env = opts.env ?? process.env;
  const readGit = opts.git ?? gitConfig;
  const base = defaultConfig();

  let file: Record<string, unknown> = {};
  const path = configPath(env);
  const f = Bun.file(path);
  if (await f.exists()) file = Bun.TOML.parse(await f.text()) as Record<string, unknown>;

  const s: Sources = { env, file, git: readGit };
  const fileDefaults = (file.defaults ?? {}) as Record<string, unknown>;
  const fileHub = file.hub as { url?: unknown } | undefined;

  const rootRaw = await pick(s, "CCX_ROOT", "ccx.root", "root");
  const root = rootRaw ? expandTilde(rootRaw) : base.root;

  const mirrorRaw = await pick(s, "CCX_MIRROR_ROOT", "ccx.mirrorRoot", "mirrorRoot");
  const maxAgeRaw = await pick(s, "CCX_MIRROR_MAX_AGE", "ccx.mirrorMaxAge", "mirrorMaxAge");
  const protocolRaw = await pick(s, "CCX_PROTOCOL", "ccx.protocol", "protocol");

  const agent =
    env.CCX_AGENT ?? (await readGit("ccx.agent")) ?? (fileDefaults.agent as string | undefined);
  const model =
    env.CCX_MODEL ?? (await readGit("ccx.model")) ?? (fileDefaults.model as string | undefined);
  const hubUrl = env.CCX_HUB_URL ?? (await readGit("ccx.hubUrl")) ?? (fileHub?.url as string | undefined);

  return {
    root,
    mirrorRoot: mirrorRaw ? expandTilde(mirrorRaw) : join(root, ".mirror"),
    defaultHost: (await pick(s, "CCX_DEFAULT_HOST", "ccx.defaultHost", "defaultHost")) ?? base.defaultHost,
    defaultOwner: (await pick(s, "CCX_DEFAULT_OWNER", "ccx.defaultOwner", "defaultOwner")) ?? undefined,
    protocol: protocolRaw ? parseProtocol(protocolRaw) : base.protocol,
    mirrorMaxAgeMs: maxAgeRaw ? parseDuration(maxAgeRaw) : base.mirrorMaxAgeMs,
    defaults: {
      agent: agent || base.defaults.agent,
      model: model || undefined,
    },
    hub: hubUrl ? { url: String(hubUrl) } : undefined,
  };
}
