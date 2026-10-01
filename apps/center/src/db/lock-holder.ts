/**
 * テスト用。指定の DB に排他ロックを掴み、掴んだことをファイルで知らせ、少し待って
 * から離す。
 *
 * 別プロセスにしてあるのは、bun:sqlite が同期 API だから。同じプロセスで掴もうと
 * しても、openDb がスレッドを塞いでいる間はタイマもコールバックも走らないので、
 * 「ロックが後から外れる」状況を作れない (エラーにならず、ただ再現しない)。
 */
import { Database } from "bun:sqlite";

const [dbPath, readyFile, holdMsRaw] = process.argv.slice(2);
if (!dbPath || !readyFile) {
  process.stderr.write("usage: lock-holder <db> <ready-file> [hold-ms]\n");
  process.exit(2);
}
const holdMs = Number(holdMsRaw ?? 400);

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA busy_timeout = 0");
db.exec("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)");
db.exec("BEGIN EXCLUSIVE");
db.exec("INSERT INTO lock_probe (x) VALUES (1)");

await Bun.write(readyFile, "locked");
await Bun.sleep(holdMs);

db.exec("COMMIT");
db.close();
