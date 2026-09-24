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

import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

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
  /**
   * このマシンの名前。ccx-agent と同じ規則 (CCX_MACHINE / ccx.machine / machine / hostname)。
   * center の event と transcript の保存先の両方でマシンを指す鍵なので、揃っていないと
   * `ccx session` と `ccx transcript ls` が同じマシンを別名で呼ぶ
   */
  machine: string;
  /**
   * 未設定なら hub 無し = ローカル単独動作。token は center の CCX_CENTER_TOKEN と
   * 同じ値 (#158)。CCX_HUB_TOKEN か、config.toml の隣の `hub-token` ファイルから
   */
  hub?: { url: string; token?: string };
  /**
   * transcript の保存先 (S3 互換)。未設定なら `ccx transcript` だけが使えない。
   * endpoint を書かなければ hub.url (center の object API) が保存先になる。token を持つのは
   * 保存先が center のとき (無指定か、hub.url と同じ origin) だけ。外部の S3 に center の token を送らない
   */
  transcript?: { endpoint: string; bucket: string; prefix: string; region?: string; token?: string };
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

/** key の prefix は空か `/` 終わり、先頭に `/` は無し。`a` と `a/` を別の場所にしない */
export function normalizePrefix(raw: string): string {
  const p = raw.replace(/^\/+/, "");
  return p && !p.endsWith("/") ? `${p}/` : p;
}

/**
 * center の token。git config と config.toml には置かない (dotfiles ごと共有・公開
 * されやすい置き場所なので)。env か、config.toml の隣の専用ファイル
 */
async function readHubToken(env: Record<string, string | undefined>): Promise<string | undefined> {
  const fromEnv = env.CCX_HUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const path = join(dirname(configPath(env)), "hub-token");
  const f = Bun.file(path);
  if (!(await f.exists())) return undefined;
  // 読めない / 他人に読める token を黙って無視すると、「設定したのに 401」の原因が見えなくなる
  if (((await f.stat()).mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users; chmod 600 it (it holds the center's token)`);
  }
  return (await f.text()).trim() || undefined;
}

/** transcript の endpoint を明示していても、それが center 自身なら center の token を渡す */
function sameOrigin(a: string, b: string | undefined): boolean {
  if (!b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
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
    machine: hostname(),
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
  const hubToken = await readHubToken(env);

  // [transcript] テーブルは同じ 3 段で引く。endpoint だけは hub.url に落ちる。
  // ただし center の object API は HTTP なので、hub.url が http(s) でなければ落とさない
  const t: Sources = { ...s, file: (file.transcript ?? {}) as Record<string, unknown> };
  const hubHttp = hubUrl && /^https?:\/\//.test(hubUrl) ? hubUrl : undefined;
  const tExplicit = await pick(t, "CCX_TRANSCRIPT_ENDPOINT", "ccx.transcriptEndpoint", "endpoint");
  const tEndpoint = tExplicit ?? hubHttp;
  const tBucket = (await pick(t, "CCX_TRANSCRIPT_BUCKET", "ccx.transcriptBucket", "bucket")) ?? "ccx";
  const tPrefixRaw = (await pick(t, "CCX_TRANSCRIPT_PREFIX", "ccx.transcriptPrefix", "prefix")) ?? "";
  const tRegion = await pick(t, "CCX_TRANSCRIPT_REGION", "ccx.transcriptRegion", "region");

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
    machine: (await pick(s, "CCX_MACHINE", "ccx.machine", "machine")) ?? hostname(),
    hub: hubUrl ? { url: String(hubUrl), ...(hubToken ? { token: hubToken } : {}) } : undefined,
    transcript: tEndpoint
      ? {
          endpoint: String(tEndpoint),
          bucket: String(tBucket),
          prefix: normalizePrefix(tPrefixRaw),
          region: tRegion || undefined,
          ...(hubToken && (tExplicit === null || sameOrigin(tExplicit, hubHttp)) ? { token: hubToken } : {}),
        }
      : undefined,
  };
}
