import { Code, ConnectError, createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";

/**
 * center への読み出しクライアント。
 *
 * center が居なければ ccx は「フリートが見えない」だけで、repodir の操作は何も
 * 変わらない (docs/design/scope.md)。だから center が未設定であることはエラーでは
 * なく、「見る先が無い」という状態として扱う。
 */
export class NoCenterConfigured extends Error {
  constructor() {
    super(
      [
        "no center configured — nothing to read from.",
        "",
        "Point ccx at one of:",
        "  CCX_CENTER_URL=http://host:8791",
        "  git config ccx.centerUrl http://host:8791",
        "  ~/.config/ccx/config.toml   [center] url = \"http://host:8791\"",
      ].join("\n"),
    );
    this.name = "NoCenterConfigured";
  }
}

export type Center = { url: string; token?: string };

/** center への Connect の transport。token があれば全要求に Bearer で付ける (#158) */
export function centerTransport(center: Center): Transport {
  const auth: Interceptor = (next) => (req) => {
    req.header.set("Authorization", `Bearer ${center.token}`);
    return next(req);
  };
  return createConnectTransport({ baseUrl: center.url, interceptors: center.token ? [auth] : [] });
}

export function fleetClient(center: Center | undefined): Client<typeof FleetService> {
  if (!center) throw new NoCenterConfigured();
  return createClient(FleetService, centerTransport(center));
}

/**
 * center に届かなかったときのメッセージ。原因 (落ちている / URL が違う / ネットワーク)
 * まではこちらから言えないので、言えることだけを言う。
 */
export function unreachable(centerUrl: string, cause: unknown): Error {
  // 届いたうえで断られたのは「届かない」ではない。直し方が違うので分けて言う
  if (ConnectError.from(cause).code === Code.Unauthenticated) {
    return new Error(
      `ccx-center at ${centerUrl} refused the token: set CCX_CENTER_TOKEN (or ~/.config/ccx/center-token) to the value ccx-center runs with`,
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`ccx-center at ${centerUrl} did not answer: ${detail}`);
}
