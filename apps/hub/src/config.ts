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

export function loadCenterConfig(env: NodeJS.ProcessEnv = process.env): CenterConfig {
  // 既定は loopback。#91 の時点で center に認証は無く、既定で LAN に出すと
  // 「誰でも書き込める事実の器」になる。複数機械から使うときは明示的に開ける。
  const host = env.CCX_CENTER_HOST ?? "127.0.0.1";

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
