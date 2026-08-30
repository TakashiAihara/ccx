import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentStatus, defaultSocketPath, defaultSpoolDir } from "./agent.ts";

let dir: string;
let servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccx-agent-"));
});

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

function listen(path: string): Promise<void> {
  return new Promise((resolve) => {
    const s = createServer();
    servers.push(s);
    s.listen(path, () => resolve());
  });
}

describe("パスの解決", () => {
  test("env が最優先", () => {
    expect(defaultSocketPath({ CCX_SOCKET: "/s.sock" })).toBe("/s.sock");
    expect(defaultSpoolDir({ CCX_SPOOL: "/sp" })).toBe("/sp");
  });

  test("既定は XDG_RUNTIME_DIR と CCX_ROOT の下", () => {
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/9" })).toBe("/run/user/9/ccx/ccxd.sock");
    expect(defaultSpoolDir({ CCX_ROOT: "/r" })).toBe("/r/spool");
  });
});

describe("agentStatus", () => {
  test("socket も spool も無ければ、動いていないと言う", async () => {
    const st = await agentStatus(undefined, { CCX_SOCKET: join(dir, "none.sock"), CCX_SPOOL: join(dir, "none") });
    expect(st.socketPresent).toBe(false);
    expect(st.socketConnectable).toBe(false);
    expect(st.spooled).toBe(0);
    expect(st.incoming).toBe(0);
    // hub 未設定は「届かない」ではない。区別できる形で返す
    expect(st.hubReachable).toBeUndefined();
  });

  test("socket が在って繋がれば running", async () => {
    const sock = join(dir, "ccxd.sock");
    await listen(sock);
    const st = await agentStatus(undefined, { CCX_SOCKET: sock, CCX_SPOOL: join(dir, "spool") });
    expect(st.socketPresent).toBe(true);
    expect(st.socketConnectable).toBe(true);
  });

  test("死んだあとに残った socket ファイルを running と読まない", async () => {
    // ccxd が落ちても unix socket のファイルは残る。存在で判定すると、落ちた
    // agent を生きていると報告することになる
    const sock = join(dir, "stale.sock");
    await listen(sock);
    for (const s of servers) s.close();
    servers = [];

    const st = await agentStatus(undefined, { CCX_SOCKET: sock, CCX_SPOOL: join(dir, "spool") });
    expect(st.socketPresent).toBe(true);
    expect(st.socketConnectable).toBe(false);
  });

  test("spool と incoming を別々に数える", async () => {
    const spool = join(dir, "spool");
    mkdirSync(join(spool, "incoming"), { recursive: true });
    writeFileSync(join(spool, "00000000000000000001.pb"), "x");
    writeFileSync(join(spool, "00000000000000000002.pb"), "x");
    // .pb でないものは転送待ちではない (lock ファイル等)
    writeFileSync(join(spool, "ccxd.lock"), "");
    writeFileSync(join(spool, "incoming", "a.pb"), "x");

    const st = await agentStatus(undefined, { CCX_SOCKET: join(dir, "n.sock"), CCX_SPOOL: spool });
    expect(st.spooled).toBe(2);
    expect(st.incoming).toBe(1);
  });

  test("hub が設定されていて届かなければ false", async () => {
    const st = await agentStatus("http://127.0.0.1:1", {
      CCX_SOCKET: join(dir, "n.sock"),
      CCX_SPOOL: join(dir, "spool"),
    });
    expect(st.hubReachable).toBe(false);
  });

  test("hub が届けば true", async () => {
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok\n") });
    try {
      const st = await agentStatus(`http://127.0.0.1:${srv.port}`, {
        CCX_SOCKET: join(dir, "n.sock"),
        CCX_SPOOL: join(dir, "spool"),
      });
      expect(st.hubReachable).toBe(true);
    } finally {
      await srv.stop(true);
    }
  });
});
