import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

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
 */
export function openDb(path: string): Db {
  const sqlite = new Database(path, { create: true });
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  // 外部キーは今のところ無いが、後で足したときに黙って効かない状態を避ける。
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(sqlite, { schema }) as Db;
  for (const stmt of schema.ddl) db.run(stmt);
  return db;
}
