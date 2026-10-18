import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { createHash } from "node:crypto";

import { Hono } from "hono";

import { requireToken } from "./auth.ts";
import type { Db } from "./db/open.ts";
import { mountObjects, type ObjectStore } from "./objects.ts";
import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";
import { IngestService } from "@ccx/proto/ccx/v1/ingest_pb.ts";
import { ResumeService } from "@ccx/proto/ccx/v1/resume_pb.ts";
import { TranscriptService } from "@ccx/proto/ccx/v1/transcript_pb.ts";
import { resumeImpl } from "./resume.ts";
import { fleetImpl, ingestImpl } from "./services.ts";
import { transcriptImpl } from "./transcript.ts";
import { UI_HTML, UI_SCRIPT } from "./ui.ts";

// script は UI_HTML に埋めた UI_SCRIPT の 1 つだけを hash で許す。他の inline script は通さない
const UI_SCRIPT_HASH = createHash("sha256").update(UI_SCRIPT).digest("base64");
const UI_CSP = `default-src 'none'; script-src 'sha256-${UI_SCRIPT_HASH}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/**
 * Hono の上に Connect の handler を貼る。
 *
 * connect-node は node:http 前提で、Bun の fetch server とは噛み合わない。core の
 * createFetchHandler が UniversalHandler を Request → Response に変換してくれる
 * ので、それを Hono の route に載せる。
 */
export function createApp(db: Db, objects: ObjectStore, opts: { token?: string; now?: () => number } = {}): Hono {
  // 「動いている一覧」の鮮度も「もう一度取れるか」も「依頼の期限」も、center の時計で
  // 比べる。読む側 (テスト) が差し替えられるよう、1 つの時計を渡す
  const now = opts.now ?? Date.now;

  const router = createConnectRouter();
  router.service(IngestService, ingestImpl(db, now));
  router.service(FleetService, fleetImpl(db, now));
  router.service(ResumeService, resumeImpl(db, now));
  router.service(TranscriptService, transcriptImpl(objects));

  const app = new Hono();

  // 他のどの route よりも先に載せる。後に載せると、それより前に登録した route は
  // 素通りする (Hono は登録順に照合する)
  if (opts.token) app.use("*", requireToken(opts.token));

  for (const uHandler of router.handlers) {
    const handler = createFetchHandler(uHandler);
    app.all(uHandler.requestPath, (c) => handler(c.req.raw));
  }

  // 生きているかだけを返す。ccx-agent はここを見ない (見なくても spool するので)。
  // 人と、この先の `ccx agent` 用。
  app.get("/healthz", (c) => c.text("ok\n"));

  // token は page に埋めず、人が入力欄に打つ。page 自身は token なしで取れるので、
  // `/ui` は auth の例外 (GET / HEAD のみ)。CSP は、ハッシュの合う 1 つの script と inline の style
  // 以外の読込 (同じ origin のものも) と、他 origin への fetch / XHR と form の送信を止める。
  // navigation や window.open は止めない
  app.get("/ui", (c) =>
    c.body(UI_HTML, 200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": UI_CSP,
    }),
  );

  // S3 互換の object API (#121)。`/:bucket` と `/:bucket/*` を取るので、上の route
  // (`/healthz`, `/ui` と Connect) より後に載せる。Hono は登録順に照合する。`healthz` と `ui` は
  // bucket 名としても有効なので、順序を入れ替えると `/healthz` や `/ui` が object API に届く
  mountObjects(app, objects);

  return app;
}
