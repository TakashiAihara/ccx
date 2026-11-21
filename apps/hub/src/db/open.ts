import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import { Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

import { markSummarized } from "../store.ts";
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
  // 書き込みロックを取ってから見るので、同時に開いた 2 つ目が作り直しを重ねることは無い。ただし作り直しの間 (大きい DB で
  // 数十秒) ロックを持つので、2 つ目の起動と他プロセスの書き込みは busy_timeout (5 秒) を過ぎると SQLITE_BUSY で落ちる
  db.transaction(
    (tx) => {
      const hadSummary = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_summary'").get() !== null;
      for (const stmt of schema.ddl) tx.run(stmt);
      const mark = sqlite.query("SELECT last_event_rowid AS n FROM session_summary_mark WHERE id = 1").get() as { n: number } | null;
      if (!hadSummary || mark === null) buildSessionSummary(tx);
      else catchUpSessionSummary(sqlite, tx, mark.n);
      markSummarized(tx);
    },
    { behavior: "immediate" },
  );
  return db;
}

/**
 * 目印より後に入った行の session を、events から作り直す (#340)。ここに来るのは ingest が目印を進めなかった行で、目印を知らない
 * 古い版の center が書いた分と、その後でこの版が書いた分 (目印が末尾に居ないので進めなかった) がある。古い版が集計表も足していた
 * か (#335〜#346) いないか (#335 より前) はこちらから分からず、1 件ずつ足し直すと前者で件数が二重になるので、触れた session の行
 * を消して作り直す。宣言状態や session の無い行の鍵も混ざるが、作り直しの絞り込みで何も入らない。ふだんは 0 行で、rowid の範囲
 * を索引で引くだけ
 */
function catchUpSessionSummary(sqlite: Database, tx: Pick<Db, "run">, after: number): void {
  const keys = sqlite
    .query(`SELECT DISTINCT machine, os_user, session_id FROM events WHERE rowid > ?`)
    .all(after) as SessionKey[];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) buildSessionSummary(tx, keys.slice(i, i + KEY_CHUNK));
}

type SessionKey = { machine: string; os_user: string; session_id: string };

/** 1 文に入れる session の数。1 件に 3 個の変数を使うので 1 文 1,500 個で、SQLite の 1 文の上限 (3.32 以降 32,766) に収まる */
const KEY_CHUNK = 500;

/**
 * session_summary を events から作り直す (#307)。keys を渡せばその session だけ、省けば全部。
 * 全部を作り直すのは表を足す前からある DB と目印 (session_summary_mark) の行が無いときで、作り直したいときは目印の行を消して
 * 起動し直す (DROP TABLE session_summary でもよい)。events を全部読むので大きい DB では数十秒かかり、その間 center は起動しない。
 * 完全に同じ (received_at_ms, seq) の event どうしは先に入った方 (rowid の小さい方) を取り、ingest の summarize と揃える。
 */
function buildSessionSummary(tx: Pick<Db, "run">, keys?: SessionKey[]): void {
  const only = keys ? sql`AND (machine, os_user, session_id) IN (${sql.join(keys.map((k) => sql`(${k.machine}, ${k.os_user}, ${k.session_id})`), sql`, `)})` : sql``;
  tx.run(sql`DELETE FROM session_summary WHERE 1 ${only}`);
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
        WHERE session_id != '' AND producer = ${Producer.CLAUDE_CODE_HOOK} ${only}
        WINDOW w AS (PARTITION BY machine, os_user, session_id)
      )
      WHERE rn = 1
  `);
}
