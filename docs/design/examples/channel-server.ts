#!/usr/bin/env bun
/**
 * 最小の Channel MCP server (検証用)。
 *
 * ファイル /root/.chtest/inbox を監視し、内容が書かれたら
 * notifications/claude/channel でセッションに push する。
 * これで「外部プロセスがセッションに差し込む」を再現できる。
 */

const INBOX = "/root/.chtest/inbox";
const LOG = "/root/.chtest/server.log";

const log = (m: string) =>
  Bun.write(LOG, `[${new Date().toISOString()}] ${m}\n`, { createPath: true }).catch(() => {});

const send = (obj: unknown) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

// ---- MCP stdio: 行区切り JSON-RPC ----
const decoder = new TextDecoder();
let buf = "";

process.stdin.on("data", (chunk: Buffer) => {
  buf += decoder.decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;

    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    log(`recv ${msg.method ?? "(response)"} id=${msg.id ?? "-"}`);

    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          // これが channel server であることの宣言
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "ccxd-test", version: "0.1.0" },
        },
      });
      continue;
    }

    if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
      continue;
    }

    // 通知には応答しない
    if (msg.id === undefined) continue;

    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});

// ---- inbox を監視して push ----
let last = "";
setInterval(async () => {
  const f = Bun.file(INBOX);
  if (!(await f.exists())) return;
  const text = (await f.text()).trim();
  if (!text || text === last) return;
  last = text;

  log(`PUSH: ${text}`);
  send({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: text, meta: { origin: "ccxd" } },
  });
  await Bun.write(INBOX, "");
  last = "";
}, 1000);

log("server started");
