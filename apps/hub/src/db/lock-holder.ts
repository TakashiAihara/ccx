/**
 * テスト用。指定の DB に排他ロックを掴み、掴んだことをファイルで知らせ、少し待って
 * から離す。
 *
 * 別プロセスにしてあるのは、bun:sqlite が同期 API だから。同じプロセスで掴もうと
 * しても、openDb がスレッドを塞いでいる間はタイマもコールバックも走らないので、
 * 「ロックが後から外れる」状況を作れない (エラーにならず、ただ再現しない)。
 */
import { Database } from "bun:sqlite";

// sql を渡すと、ロックを持っている間にそれを書く (ロックの間に他のプロセスが書いた行を作るため)
const [dbPath, readyFile, holdMsRaw, writeSql] = process.argv.slice(2);
if (!dbPath || !readyFile) {
  process.stderr.write("usage: lock-holder <db> <ready-file> [hold-ms] [sql]\n");
  process.exit(2);
}
const holdMs = Number(holdMsRaw ?? 400);

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA busy_timeout = 0");
db.exec("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)");
db.exec("BEGIN EXCLUSIVE");
db.exec(writeSql ?? "INSERT INTO lock_probe (x) VALUES (1)");

await Bun.write(readyFile, "locked");
await Bun.sleep(holdMs);

db.exec("COMMIT");
db.close();
// 離した後で知らせる。待つ側は、自分の操作の前にこれが無かったことで、ロックの中に入ったと言える
await Bun.write(`${readyFile}.done`, "released");
