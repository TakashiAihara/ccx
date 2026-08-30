import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { Hono } from "hono";

import type { Db } from "./db/open.ts";
import { FleetService } from "./gen/ts/ccx/v1/fleet_pb.ts";
import { IngestService } from "./gen/ts/ccx/v1/ingest_pb.ts";
import { fleetImpl, ingestImpl } from "./services.ts";

/**
 * Hono の上に Connect の handler を貼る。
 *
 * connect-node は node:http 前提で、Bun の fetch server とは噛み合わない。core の
 * createFetchHandler が UniversalHandler を Request → Response に変換してくれる
 * ので、それを Hono の route に載せる。
 */
export function createApp(db: Db): Hono {
  const router = createConnectRouter();
  router.service(IngestService, ingestImpl(db));
  router.service(FleetService, fleetImpl(db));

  const app = new Hono();

  for (const uHandler of router.handlers) {
    const handler = createFetchHandler(uHandler);
    app.all(uHandler.requestPath, (c) => handler(c.req.raw));
  }

  // 生きているかだけを返す。ccxd はここを見ない (見なくても spool するので)。
  // 人と、この先の `ccx agent` 用。
  app.get("/healthz", (c) => c.text("ok\n"));

  return app;
}
