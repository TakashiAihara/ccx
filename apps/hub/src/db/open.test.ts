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

test("他プロセスがロックを握っていても、待って開ける", async () => {
  // 順序の回帰テスト。busy_timeout より先に journal_mode を切り替えると、その
  // 切り替え自体がロックを取りにいって SQLITE_BUSY で即死する = center が起動しない。
  //
  // 測る側と測られる側を別プロセスに置く。bun:sqlite は同期なので、同じプロセスだと
  // openDb がスレッドを塞いでいる間タイマが動かず、「後からロックが外れる」状況を
  // そもそも作れない (落ちるのではなく、静かに再現しないだけになる)。
  dir = mkdtempSync(join(tmpdir(), "ccx-lock-"));
  const dbPath = join(dir, "center.db");
  const ready = join(dir, "ready");

  const holder = Bun.spawn(
    ["bun", "run", join(import.meta.dir, "lock-holder.ts"), dbPath, ready, "600"],
    { stdout: "pipe", stderr: "pipe" },
  );

  try {
    // ロックを実際に握るまで待つ。握る前に開けても、この検査に判別能力が無い
    for (let i = 0; i < 100 && !(await Bun.file(ready).exists()); i += 1) await Bun.sleep(20);
    expect(await Bun.file(ready).exists()).toBe(true);

    const started = Date.now();
    const db = openDb(dbPath);
    const waited = Date.now() - started;
    try {
      // 待ったうえで開けたこと。即座に返っていたらロックを掴めていない
      expect(waited).toBeGreaterThan(50);
      expect(db.$client.query("PRAGMA busy_timeout").values()[0]![0]).toBeGreaterThan(0);
    } finally {
      db.$client.close();
    }
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("session ごとの宣言状態は producer つきの index で引く (#307)", () => {
  const db = openDb(":memory:");
  // store.ts の latestStates と同じ形。index が無いと session の event を全部たどって行本体を読む
  const plan = db.$client
    .query("EXPLAIN QUERY PLAN SELECT rowid, payload FROM events WHERE producer = ? AND (machine, os_user, session_id) IN ((?, ?, ?), (?, ?, ?))")
    .all(2, "m", "u", "s", "m", "u", "t") as { detail: string }[];
  expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX events_producer_session_idx (producer=? AND machine=? AND os_user=? AND session_id=?)");
  db.$client.close();
});
