import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./open.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test("ファイル DB は WAL で開き、ロック待ちを諦めない", () => {
  dir = mkdtempSync(join(tmpdir(), "ccx-db-"));
  const db = openDb(join(dir, "center.db"));
  try {
    const [mode] = db.$client.query("PRAGMA journal_mode").values()[0] as [string];
    expect(String(mode).toLowerCase()).toBe("wal");

    // 既定は 0 で、他プロセスがロックを持っていると即 SQLITE_BUSY になる。
    // ingest は全か無かなので、待てば通るものを落とすとバッチ 1 つが再送に回る
    const [ms] = db.$client.query("PRAGMA busy_timeout").values()[0] as [number];
    expect(Number(ms)).toBeGreaterThan(0);
  } finally {
    db.$client.close();
  }
});

test(":memory: でも busy_timeout は設定される", () => {
  const db = openDb(":memory:");
  try {
    const [ms] = db.$client.query("PRAGMA busy_timeout").values()[0] as [number];
    expect(Number(ms)).toBeGreaterThan(0);
  } finally {
    db.$client.close();
  }
});
