import { homedir } from "node:os";
import { join } from "node:path";

/**
 * center 自身の設定。`packages/core` の Config とは別物なので分けてある。
 * あちらは「どの center に送るか」(hub.url) を持つ側、こちらは「どこで待つか」を
 * 持つ側で、同じ機械に同居するとは限らない。
 */
export type CenterConfig = {
  host: string;
  port: number;
  dbPath: string;
};

/**
 * loopback かどうか。ここを外れる bind は、この時点の center では平文かつ無認証で
 * 公開することを意味する。
 */
export function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  // 127.0.0.0/8 全体が loopback。127.0.0.1 だけを見ると 127.0.0.2 を通してしまう
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/** 非 loopback bind を承知のうえで許すための、明示の opt-in。 */
export const INSECURE_BIND_ENV = "CCX_CENTER_ALLOW_INSECURE_BIND";

export function loadCenterConfig(env: NodeJS.ProcessEnv = process.env): CenterConfig {
  // 既定は loopback。この時点の center には認証も TLS も無く、LAN に出すと
  // 「誰でも書き込めて誰でも読める事実の器」になる。
  const host = env.CCX_CENTER_HOST ?? "127.0.0.1";

  // 設定だけで越えられる線にしない。README に書いてあることは、環境変数を 1 つ
  // 足した人には届かない。踏むときに手が止まる形にしておく。
  if (!isLoopback(host) && !env[INSECURE_BIND_ENV]) {
    throw new Error(
      [
        `refusing to bind ${host}: ccx-center has no authentication and speaks plain HTTP.`,
        "",
        "Anyone who can reach it can store events and read every collected payload.",
        "",
        "Either:",
        "  - keep the default loopback bind and put a TLS-terminating, authenticating",
        "    proxy in front of it, or",
        `  - set ${INSECURE_BIND_ENV}=1 if the network it binds to is already trusted.`,
      ].join("\n"),
    );
  }

  // Number("") は 0 を返し、下の範囲チェックも 0 を通す。env に空文字で export
  // されていると、8791 ではなく任意の空きポートに bind されて誰も気づかない。
  // 空文字は「未設定」として扱う。
  const raw = env.CCX_CENTER_PORT?.trim();
  const port = raw === undefined || raw === "" ? 8791 : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`CCX_CENTER_PORT is not a valid port: ${raw}`);
  }

  const dbPath = env.CCX_CENTER_DB ?? join(env.CCX_ROOT ?? join(homedir(), ".ccx"), "center.db");

  return { host, port, dbPath };
}
