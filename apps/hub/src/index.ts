#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { loadCenterConfig } from "./config.ts";
import { openDb } from "./db/open.ts";
import { ObjectStore } from "./objects.ts";
import { createApp } from "./server.ts";

function usage(): void {
  process.stderr.write(`ccx-center — the ccx data sink

usage:
  ccx-center serve    accept forwarded hook data and serve it back

env:
  CCX_CENTER_HOST   bind address (default 127.0.0.1)
  CCX_CENTER_PORT   bind port (default 8791)
  CCX_CENTER_DB     sqlite file (default $CCX_ROOT/center.db, or ~/.ccx/center.db)
  CCX_CENTER_OBJECTS  directory behind the S3-compatible object API
                    (default $CCX_ROOT/center-objects, or ~/.ccx/center-objects)
  CCX_CENTER_TOKEN  shared token every endpoint but /healthz requires; clients send
                    it as CCX_HUB_TOKEN. With it set the center may bind beyond loopback
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
  mkdirSync(cfg.objectsDir, { recursive: true });
  const app = createApp(db, new ObjectStore(cfg.objectsDir), { token: cfg.token });

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    fetch: app.fetch,
    // object API は本文を stream で書くのでメモリは本文の大きさに依らない。上限は
    // 「1 回の PUT で置ける object の大きさ」で、Bun の既定 128 MB は transcript
    // (実測で数 MB〜数十 MB) には足りるが、S3 クライアントが multipart に切り替える
    // 前に単発 PUT で送る上限 (aws cli は 5 GB) より小さい。1 GB で揃えておく
    maxRequestBodySize: 1024 * 1024 * 1024,
  });
  console.error(
    `ccx-center listening on http://${cfg.host}:${server.port} (db=${cfg.dbPath}, objects=${cfg.objectsDir}, token=${cfg.token ? "required" : "none"})`,
  );

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
