import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

import * as schema from "./schema.ts";

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

/**
 * DB を開き、必要ならスキーマを作る。`:memory:` を渡せばテスト用。
 *
 * WAL にするのは**別プロセスから読むため**。center 自身の ingest と読み出しは
 * bun:sqlite の同期 API で同じスレッドに直列化されるので、プロセス内では
 * そもそも待ち合わせが起きない。効くのは外から読むとき — 稼働中の DB を
 * sqlite3 で覗く、あるいは 2 つ目の center が上がってしまった場合で、rollback
 * journal だと読み手の SHARED ロックが書き手を止める。
 *
 * busy_timeout を置くのは同じ理由。既定は 0 なので、他プロセスがロックを持って
 * いると即 SQLITE_BUSY で落ちる。ingest が「全か無か」である以上、待てば通る
 * ものを落とすとバッチ 1 つが丸ごと再送に回る。
 *
 * **busy_timeout は journal_mode より先に置く。** journal_mode の切り替え自体が
 * ロックを取るので、待機時間が 0 のままだと、他プロセスが書いている最中の起動が
 * SQLITE_BUSY で落ちる。落ちるのは center の起動そのもの (openDb は起動経路)。
 * 順序を逆にした版は open.test.ts が別プロセスでロックを掴んで pin している。
 */
export function openDb(path: string): Db {
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
  // 外部キーは今のところ無いが、後で足したときに黙って効かない状態を避ける。
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(sqlite, { schema }) as Db;
  // 空かどうかではなく表が在ったかで決める。hook の event が 1 件も無い DB で起動のたびに全件を読み直さないため。
  // 書き込みロックを取ってから見るので、同時に開いた 2 つ目が作り直しを重ねることは無い。ただし作り直しの間 (大きい DB で
  // 数十秒) ロックを持つので、2 つ目の起動と他プロセスの書き込みは busy_timeout (5 秒) を過ぎると SQLITE_BUSY で落ちる
  db.transaction(
    (tx) => {
      const hadSummary = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_summary'").get() !== null;
      for (const stmt of schema.ddl) tx.run(stmt);
      if (!hadSummary) buildSessionSummary(tx);
    },
    { behavior: "immediate" },
  );
  return db;
}

/**
 * session_summary を events から作る (#307)。表を足す前からある DB と、表を DROP して作り直すときの経路。
 * events を全部読むので大きい DB では数十秒かかり、その間 center は起動しない。以後は ingest が足していく。
 * 完全に同じ (received_at_ms, seq) の event どうしは先に入った方 (rowid の小さい方) を取り、ingest の summarize と揃える。
 */
function buildSessionSummary(tx: Pick<Db, "run">): void {
  tx.run(sql`
      INSERT INTO session_summary (machine, os_user, session_id, first_seen_ms, last_seen_ms, last_seq, ended_at_ms, event_count, cwd, transcript_path, last_hook)
      SELECT machine, os_user, session_id, first_seen_ms, last_seen_ms, seq, ended_at_ms, event_count, cwd, transcript_path, hook_event_name
      FROM (
        SELECT machine, os_user, session_id, seq, cwd, transcript_path, hook_event_name,
          MIN(received_at_ms) OVER w AS first_seen_ms,
          MAX(received_at_ms) OVER w AS last_seen_ms,
          COUNT(*) OVER w AS event_count,
          MAX(CASE WHEN hook_event_name = 'SessionEnd' THEN received_at_ms END) OVER w AS ended_at_ms,
          ROW_NUMBER() OVER (PARTITION BY machine, os_user, session_id ORDER BY received_at_ms DESC, seq DESC, rowid ASC) AS rn
        FROM events
        WHERE session_id != '' AND producer = ${Producer.CLAUDE_CODE_HOOK}
        WINDOW w AS (PARTITION BY machine, os_user, session_id)
      )
      WHERE rn = 1
  `);
}
