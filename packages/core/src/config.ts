/**
 * 設定。個人環境の事情を焼き込まないための唯一の窓口。
 * ~/.config/ccx/config.toml (XDG に従う)。無くても動く。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  root: string;
  mirrorRoot: string;
  defaultHost: string;
  defaultOwner?: string;
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

  const m = v.trim().match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`invalid duration: ${v}`);

  const n = Number(m[1]);
  switch (m[2] ?? "ms") {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: throw new Error(`invalid duration: ${v}`);
  }
}

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "ccx", "config.toml");
}

export function defaultConfig(): Config {
  const root = join(homedir(), ".repodirs");
  return {
    root,
    mirrorRoot: join(root, ".mirror"),
    defaultHost: "github.com",
    mirrorMaxAgeMs: DEFAULT_MIRROR_MAX_AGE_MS,
    defaults: { agent: "claude" },
  };
}

/** 設定ファイルを読む。存在しなければデフォルトのみ。 */
export async function loadConfig(path = configPath()): Promise<Config> {
  const base = defaultConfig();

  const file = Bun.file(path);
  if (!(await file.exists())) return base;

  const raw = Bun.TOML.parse(await file.text()) as Record<string, unknown>;

  const root = raw.root ? expandTilde(String(raw.root)) : base.root;
  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  const hub = raw.hub as { url?: unknown } | undefined;

  return {
    root,
    mirrorRoot: raw.mirrorRoot ? expandTilde(String(raw.mirrorRoot)) : join(root, ".mirror"),
    defaultHost: raw.defaultHost ? String(raw.defaultHost) : base.defaultHost,
    defaultOwner: raw.defaultOwner ? String(raw.defaultOwner) : undefined,
    mirrorMaxAgeMs: raw.mirrorMaxAge ? parseDuration(raw.mirrorMaxAge) : base.mirrorMaxAgeMs,
    defaults: {
      agent: defaults.agent ? String(defaults.agent) : base.defaults.agent,
      model: defaults.model ? String(defaults.model) : undefined,
    },
    hub: hub?.url ? { url: String(hub.url) } : undefined,
  };
}
