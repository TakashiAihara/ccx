import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `serve` は起動して「返る」。返ったあともプロセスが残ることを、実際に起動して
// 確かめる。単体テストは createApp までしか触らないので、entry point が起動直後に
// exit する壊れ方はそこでは見えない (実際に一度そうなった)。
let proc: Bun.Subprocess | undefined;
let dir: string | undefined;

afterEach(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
  proc = undefined;
  dir = undefined;
});

// 起動ログの `listening on http://<host>:<port>` から実際に bind したポートを読む。
async function listeningPort(stderr: ReadableStream<Uint8Array>): Promise<number> {
  // for await から return すると stream が cancel され、子の後の stderr 書き込みが EPIPE になる。
  // lock を外すだけでも、誰も読まない pipe が 64KB で埋まると子の書き込みが止まる。
  // ポートを読んだ後も EOF まで裏で読み捨てる (#342)
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    // 数字の後ろの 1 文字まで待つ。チャンクが数字の途中で切れると桁が欠けるため
    const m = text.match(/listening on http:\/\/\S+:(\d+)\D/);
    if (m) {
      void (async () => {
        while (!(await reader.read()).done) {}
      })().catch(() => {});
      return Number(m[1]);
    }
  }
  throw new Error(`ccx-center exited before listening: ${text}`);
}

test("ccx-center serve は起動したまま応答し続ける", async () => {
  dir = mkdtempSync(join(tmpdir(), "ccx-center-"));

  proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "serve"], {
    env: {
      ...process.env,
      CCX_CENTER_HOST: "127.0.0.1",
      // port 0 で OS に空きを選ばせる。乱数で選ぶと ephemeral port と重なり EADDRINUSE で落ちる (#338)
      CCX_CENTER_PORT: "0",
      CCX_CENTER_DB: join(dir, "center.db"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  const port = await listeningPort(proc.stderr as ReadableStream<Uint8Array>);
  // 設定値の 0 をそのまま出す壊れ方では、0 に fetch して timeout まで待つことになる
  expect(port).toBeGreaterThan(0);
  const url = `http://127.0.0.1:${port}/healthz`;
  let ok = false;
  for (let i = 0; i < 60 && !ok; i += 1) {
    ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (!ok) await Bun.sleep(100);
  }
  expect(ok).toBe(true);

  // 一度応答したあとも生きていること。起動して即 exit する形だと、
  // 運が良ければ 1 回目の fetch は通ってしまう。
  await Bun.sleep(300);
  expect(proc.exitCode).toBeNull();
  expect(await fetch(url).then((r) => r.ok)).toBe(true);
});

test("ポートを読んだ後に stderr へ pipe の容量を超えて書いても子は止まらない", async () => {
  // 1MB は pipe の容量 (64KB) を十分超える。読み捨てていなければ子は書き込みで止まり exit しない。
  // 子を bun にすると書き込みが止まらず exit するので対照にならない (実測)
  proc = Bun.spawn(
    ["bash", "-c", `echo "listening on http://127.0.0.1:4242 " >&2; head -c 1048576 /dev/zero >&2`],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(await listeningPort(proc.stderr as ReadableStream<Uint8Array>)).toBe(4242);
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
  expect(exited).toBe(true);
});

test("知らないコマンドは usage を出して exit 2", async () => {
  const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "nonsense"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await p.exited).toBe(2);
  expect(await new Response(p.stderr).text()).toContain("usage:");
});
