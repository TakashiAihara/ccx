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

test("ccx-center serve は起動したまま応答し続ける", async () => {
  dir = mkdtempSync(join(tmpdir(), "ccx-center-"));
  const port = 20000 + Math.floor(Math.random() * 20000);

  proc = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "serve"], {
    env: {
      ...process.env,
      CCX_CENTER_HOST: "127.0.0.1",
      CCX_CENTER_PORT: String(port),
      CCX_CENTER_DB: join(dir, "center.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

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

test("知らないコマンドは usage を出して exit 2", async () => {
  const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "nonsense"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await p.exited).toBe(2);
  expect(await new Response(p.stderr).text()).toContain("usage:");
});
