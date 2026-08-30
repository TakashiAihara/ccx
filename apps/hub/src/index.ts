#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { loadCenterConfig } from "./config.ts";
import { openDb } from "./db/open.ts";
import { createApp } from "./server.ts";

function usage(): void {
  process.stderr.write(`ccx-center — the ccx data sink

usage:
  ccx-center serve    accept forwarded hook data and serve it back

env:
  CCX_CENTER_HOST   bind address (default 127.0.0.1)
  CCX_CENTER_PORT   bind port (default 8791)
  CCX_CENTER_DB     sqlite file (default $CCX_ROOT/center.db, or ~/.ccx/center.db)
`);
}

function serve(): void {
  let cfg;
  try {
    cfg = loadCenterConfig();
  } catch (e) {
    // 設定の誤りは「壊れた」ではなく「そう書いてある」。スタックを出しても
    // 直し方は伝わらないので、本文だけ出す
    process.stderr.write(`ccx-center: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  mkdirSync(dirname(cfg.dbPath), { recursive: true });

  const db = openDb(cfg.dbPath);
  const app = createApp(db);

  const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch });
  console.error(`ccx-center listening on http://${cfg.host}:${server.port} (db=${cfg.dbPath})`);

  const stop = () => {
    void server.stop();
    db.$client.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // ここで返っても Bun.serve が event loop を掴んでいるのでプロセスは残る。
  // 呼び出し側で process.exit() しないこと — 起動直後に落ちる。
}

const cmd = process.argv[2];
if (cmd === "serve") {
  serve();
} else if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  usage();
  process.exit(0);
} else {
  if (cmd) process.stderr.write(`ccx-center: unknown command ${JSON.stringify(cmd)}\n\n`);
  usage();
  process.exit(2);
}
