import { timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

/**
 * token に使える文字。S3 の署名は access key id を `Credential=<id>/<date>/...` の形で運ぶので、
 * `/` や `,` や空白を含む token は切れて一致しなくなる (Bearer だけ通り、object API だけ落ちる)。
 * 短すぎる token は総当たりに弱い
 */
export const TOKEN_SHAPE = /^[A-Za-z0-9._~-]{16,}$/;

/**
 * 要求が持ってきた token を取り出す。受けるのは 2 つの形:
 *
 * - `Authorization: Bearer <token>` — Connect の RPC (ccx-agent / ccx CLI)
 * - `Authorization: AWS4-HMAC-SHA256 Credential=<token>/...` — S3 クライアントの署名
 *
 * S3 の方は access key id を token として読むだけで、署名は検証しない。どちらの形でも
 * token は要求ごとに平文で流れるので、強さは同じ。
 * presigned URL (`?X-Amz-Credential=`) は受けない。署名も期限も見ない以上、URL を渡すことが
 * token を無期限で渡すことになる。repo の中に presigned URL を作る側は無い。
 * ponytail: 署名を secret=token で検証すれば S3 の経路では token が線に乗らなくなり、presigned も
 * 期限付きで受けられる。TLS を入れないまま盗聴を気にする段になったらそこまで上げる
 */
export function presentedToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (bearer) return bearer[1];
  const sig = /^AWS4-HMAC-SHA256\s+Credential=([^/,\s]+)\//i.exec(authorization);
  return sig ? sig[1] : undefined;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const HINT =
  "missing or wrong token: set CCX_HUB_TOKEN (or ~/.config/ccx/hub-token) to the center's CCX_CENTER_TOKEN";

/**
 * token が一致しない要求を 401 で返す。`GET /healthz` だけは生死の確認なので通す。
 * method まで見るのは、`/healthz` は bucket 名としても有効で、`PUT /healthz` が object API の
 * CreateBucket に届くから
 */
export function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/healthz" && (c.req.method === "GET" || c.req.method === "HEAD")) return next();
    const auth = c.req.header("authorization");
    const got = presentedToken(auth);
    if (got !== undefined && same(got, token)) return next();

    // S3 クライアントは XML の Error を読んで Message を出す。平文だと「応答を読めない」としか
    // 言わず、直し方が伝わらない
    if (auth?.startsWith("AWS4-")) {
      return c.body(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${HINT}</Message></Error>`, 401, {
        "content-type": "application/xml",
      });
    }
    return c.text(`ccx-center: ${HINT}\n`, 401);
  };
}
