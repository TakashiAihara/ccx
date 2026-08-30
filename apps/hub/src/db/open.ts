import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.ts";

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

/**
 * DB を開き、必要ならスキーマを作る。`:memory:` を渡せばテスト用。
 *
 * WAL にするのは、書き込み (ingest) と読み出し (fleet API) が同じプロセスの中で
 * 並行するため。既定の rollback journal だと読み手が書き手を待つ。
 */
export function openDb(path: string): Db {
  const sqlite = new Database(path, { create: true });
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
  // 外部キーは今のところ無いが、後で足したときに黙って効かない状態を避ける。
  sqlite.exec("PRAGMA foreign_keys = ON");

  const db = drizzle(sqlite, { schema }) as Db;
  for (const stmt of schema.ddl) db.run(stmt);
  return db;
}
