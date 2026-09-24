import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

/**
 * 要求が持ってきた token を取り出す。受けるのは 3 つの形:
 *
 * - `Authorization: Bearer <token>` — Connect の RPC (ccx-agent / ccx CLI)
 * - `Authorization: AWS4-HMAC-SHA256 Credential=<token>/...` — S3 クライアントの署名
 * - `?X-Amz-Credential=<token>/...` — S3 の presigned URL
 *
 * S3 の 2 つは access key id を token として読むだけで、署名は検証しない。
 * access key id は平文で流れるので強さは Bearer と同じ。
 * ponytail: 署名を secret=token で検証すれば、token を線に流さずに済む。TLS を入れないまま
 * 盗聴を気にする段になったらそこまで上げる
 */
export function presentedToken(authorization: string | undefined, url: URL): string | undefined {
  if (authorization) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (bearer) return bearer[1];
    const sig = /^AWS4-HMAC-SHA256\s+Credential=([^/,\s]+)\//i.exec(authorization);
    if (sig) return sig[1];
    return undefined;
  }
  const cred = url.searchParams.get("X-Amz-Credential");
  return cred ? cred.split("/")[0] : undefined;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** token が一致しない要求を 401 で返す。`/healthz` は生死の確認なので通す */
export function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/healthz") return next();
    const got = presentedToken(c.req.header("authorization"), new URL(c.req.url));
    if (got === undefined || !same(got, token)) {
      return c.text("ccx-center: missing or wrong token (set CCX_HUB_TOKEN to the center's CCX_CENTER_TOKEN)\n", 401);
    }
    return next();
  };
}
