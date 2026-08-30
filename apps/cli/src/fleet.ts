import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";

/**
 * center への読み出しクライアント。
 *
 * center が居なければ ccx は「フリートが見えない」だけで、repodir の操作は何も
 * 変わらない (docs/design/scope.md)。だから hub が未設定であることはエラーでは
 * なく、「見る先が無い」という状態として扱う。
 */
export class NoCenterConfigured extends Error {
  constructor() {
    super(
      [
        "no center configured — nothing to read from.",
        "",
        "Point ccx at one of:",
        "  CCX_HUB_URL=http://host:8791",
        "  git config ccx.hubUrl http://host:8791",
        "  ~/.config/ccx/config.toml   [hub] url = \"http://host:8791\"",
      ].join("\n"),
    );
    this.name = "NoCenterConfigured";
  }
}

export function fleetClient(hubUrl: string | undefined): Client<typeof FleetService> {
  if (!hubUrl) throw new NoCenterConfigured();
  return createClient(FleetService, createConnectTransport({ baseUrl: hubUrl }));
}

/**
 * center に届かなかったときのメッセージ。原因 (落ちている / URL が違う / ネットワーク)
 * まではこちらから言えないので、言えることだけを言う。
 */
export function unreachable(hubUrl: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`ccx-center at ${hubUrl} did not answer: ${detail}`);
}
