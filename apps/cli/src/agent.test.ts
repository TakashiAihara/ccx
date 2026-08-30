import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentStatus, defaultSocketPath, defaultSpoolDir } from "./agent.ts";

let dir: string;
let servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccx-agent-"));
});

/** listen 中の server を全部閉じ、実際に閉じ切るまで待つ。 */
async function closeAll(): Promise<void> {
  const closing = servers.map((s) => new Promise<void>((res) => s.close(() => res())));
  servers = [];
  await Promise.all(closing);
}

afterEach(async () => {
  await closeAll();
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
    // agent を生きていると報告することになる。
    //
    // その状態を、listen してから close するやり方では作れない。node は unix
    // socket を close 時に unlink するので、消えるのが先か観測が先かで結果が
    // 変わる (最初にそう書いて、ローカルでは通り CI で落ちた)。listen 中に
    // hard link を張っておくと、close が元の名前を消してもリンク先は socket の
    // まま残り、しかも誰も listen していない。
    const live = join(dir, "live.sock");
    const stale = join(dir, "stale.sock");
    await listen(live);
    linkSync(live, stale);
    await closeAll();

    const st = await agentStatus(undefined, { CCX_SOCKET: stale, CCX_SPOOL: join(dir, "spool") });
    expect(st.socketPresent).toBe(true);
    expect(st.socketConnectable).toBe(false);
  });

  test("spool と incoming を別々に数え、雑音を数えない", async () => {
    // 拡張子は ccxd 側の実装が正。転送待ちは .pb、hook が直接落としたものは .raw。
    // どちらのディレクトリにも lock や書きかけの一時ファイルが同居する
    const spool = join(dir, "spool");
    mkdirSync(join(spool, "incoming"), { recursive: true });
    writeFileSync(join(spool, "00000000000000000001.pb"), "x");
    writeFileSync(join(spool, "00000000000000000002.pb"), "x");
    writeFileSync(join(spool, "ccxd.lock"), "");
    writeFileSync(join(spool, "00000000000000000003.tmp"), "x");

    writeFileSync(join(spool, "incoming", "01a050e6-8722-7c8a-9041-f38193f5a46f.raw"), "x");
    writeFileSync(join(spool, "incoming", "ccxd.lock"), "");
    writeFileSync(join(spool, "incoming", "half-written.tmp"), "x");
    // incoming に .pb は置かれない。ここを .pb で数えていると 0 件になる
    writeFileSync(join(spool, "incoming", "wrong-ext.pb"), "x");

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

  test("URL として読めない hub は、届かないのとは別の状態として返す", async () => {
    // scheme を書き忘れただけで status 全体が落ちるのは、用途に対して過剰
    const st = await agentStatus("127.0.0.1:8791", {
      CCX_SOCKET: join(dir, "n.sock"),
      CCX_SPOOL: join(dir, "spool"),
    });
    expect(st.hubUrlInvalid).toBe(true);
    expect(st.hubReachable).toBe(false);
    // ccxd 側の情報は URL が壊れていても取れる
    expect(st.socketConnectable).toBe(false);
  });

  test("正しい URL では hubUrlInvalid が立たない", async () => {
    const st = await agentStatus("http://127.0.0.1:1", {
      CCX_SOCKET: join(dir, "n.sock"),
      CCX_SPOOL: join(dir, "spool"),
    });
    expect(st.hubUrlInvalid).toBeUndefined();
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
