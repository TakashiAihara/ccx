import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 集めた event を 1 行 1 件で持つテーブル。
 *
 * 生 payload を必ず残し、派生値 (session_id / hook_event_name / cwd /
 * transcript_path) は同じ行の隣に置く。派生値を別テーブルに切らないのは、
 * 「導出をやり直せる」ことがこの設計の核だから (ingest.proto)。行が 1 つなら、
 * パーサを直したあとに全行を読み直して埋め直せる。
 *
 * session は行として持たない。event から GROUP BY で導く。session テーブルを
 * 別に持つと、それは 2 つ目の真実源になり、raw と食い違ったときにどちらが正か
 * 言えなくなる。件数が効いてくるまではこの形でよい。
 */
export const events = sqliteTable(
  "events",
  {
    // ccx-agent が採番した UUIDv7。center 側の重複排除キー (ingest.proto)。
    eventId: text("event_id").primaryKey(),

    // ここから 3 つは ccx-agent 自身の環境から来た値で、payload からは読んでいない。
    machine: text("machine").notNull(),
    // "user" は SQLite の予約語ではないが、他の SQL 方言では予約されている。
    // 将来 Postgres に移すときに黙って壊れないよう、列名を分けておく。
    user: text("os_user").notNull(),
    seq: integer("seq").notNull(),

    // ccx-agent の時計。epoch ミリ秒。payload の中の時刻ではない。
    receivedAtMs: integer("received_at_ms").notNull(),

    // ccx.v1.Producer の数値。
    producer: integer("producer").notNull(),

    // hook の stdin をそのまま。center はここを読んで下の派生値を作るが、
    // 読めなくてもこの列は必ず埋まる。
    payload: blob("payload", { mode: "buffer" }).notNull(),

    // --- ここから下は payload から導出した値 ---

    // payload が JSON オブジェクトとして読めたか。読めなかった行も捨てない。
    // 捨てると「パーサが壊れている」と「その event が無い」が区別できなくなる。
    parsed: integer("parsed", { mode: "boolean" }).notNull(),

    // 読めなかった、あるいはキーが無かったときは空文字。NULL にしないのは、
    // 「無い」と「空だった」を SQL で区別する必要がこの層では無く、
    // 片方に寄せたほうが問い合わせが単純になるため。
    sessionId: text("session_id").notNull().default(""),
    hookEventName: text("hook_event_name").notNull().default(""),
    cwd: text("cwd").notNull().default(""),
    transcriptPath: text("transcript_path").notNull().default(""),
  },
  (t) => [
    // session の一覧と 1 session の履歴。ListSessions の GROUP BY もこれに乗る。
    index("events_session_idx").on(t.machine, t.user, t.sessionId, t.receivedAtMs),
    // 「machine Y で T 以降に何が起きたか」。
    index("events_machine_time_idx").on(t.machine, t.user, t.receivedAtMs),
    // hook 種別での絞り込み。SessionEnd の有無を引くのもここ。
    index("events_hook_idx").on(t.hookEventName, t.receivedAtMs),
    // 絞り込み無しの時系列。
    index("events_time_idx").on(t.receivedAtMs),
    // 空の event_id は重複排除の役に立たない。再送のたびに行が増えるだけなので、
    // API 層のチェック (services.ts) とは別に、DB 側でも拒む。
    check("events_event_id_not_empty", sql`event_id <> ''`),
  ],
);

/**
 * 人が置いた「開き直して」の依頼 (#261)。その session のあるマシンの ccx-agent が取りに
 * 行って、開いた結果を返す。
 *
 * event テーブルと違うのは、依頼が「誰が・いつ・何をしたか」の写しではなく、1 行が
 * そのまま 1 件の依頼である点。行が段階と結果を持つので、center は「まだ誰も取って
 * いない」「取られたまま結果が返っていない」を時刻の比較だけで言える。
 */
export const resumeRequests = sqliteTable(
  "resume_requests",
  {
    // center が振る UUIDv7 (Bun.randomUUIDv7)。
    id: text("id").primaryKey(),

    // 開く session の場所。events の origin と同じ形だが、送り手の環境値ではなく
    // 人が埋める値。
    machine: text("machine").notNull(),
    user: text("os_user").notNull(),
    sessionId: text("session_id").notNull(),

    // archived でも開く (`ccx session resume --force`)。
    force: integer("force", { mode: "boolean" }).notNull().default(false),

    // 置かれた / 誰かが取った / 結果が返った。NULL はその段階に居ないことを表す。
    requestedAtMs: integer("requested_at_ms").notNull(),
    claimedAtMs: integer("claimed_at_ms"),
    finishedAtMs: integer("finished_at_ms"),

    // ccx.v1.ResumeOutcome の数値。UNSPECIFIED のままならまだ結果が無い。
    outcome: integer("outcome").notNull().default(0),
    // FAILED の理由、OPENED なら開いた workspace と pane。
    detail: text("detail").notNull().default(""),
    exitCode: integer("exit_code").notNull().default(0),
  },
  (t) => [
    // Claim が「まだ誰にも渡っていない最古の 1 件」を探す窓。
    index("resume_requests_pending_idx").on(t.machine, t.user, t.finishedAtMs, t.requestedAtMs),
    // 一覧の requested_at の新しい順。
    index("resume_requests_requested_at_idx").on(t.requestedAtMs),
  ],
);

/**
 * スキーマの DDL。drizzle-kit の migration ファイルを使わないのは、テーブルが
 * 2 つで、center が起動時に自分で用意できる範囲だから。増えたらそのとき入れる。
 */
export const ddl = [
  sql`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      seq INTEGER NOT NULL,
      received_at_ms INTEGER NOT NULL,
      producer INTEGER NOT NULL,
      payload BLOB NOT NULL,
      parsed INTEGER NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      hook_event_name TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      transcript_path TEXT NOT NULL DEFAULT '',
      CONSTRAINT events_event_id_not_empty CHECK (event_id <> '')
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS events_session_idx ON events (machine, os_user, session_id, received_at_ms)`,
  sql`CREATE INDEX IF NOT EXISTS events_machine_time_idx ON events (machine, os_user, received_at_ms)`,
  sql`CREATE INDEX IF NOT EXISTS events_hook_idx ON events (hook_event_name, received_at_ms)`,
  sql`CREATE INDEX IF NOT EXISTS events_time_idx ON events (received_at_ms)`,
  sql`
    CREATE TABLE IF NOT EXISTS resume_requests (
      id TEXT PRIMARY KEY,
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      session_id TEXT NOT NULL,
      force INTEGER NOT NULL DEFAULT 0,
      requested_at_ms INTEGER NOT NULL,
      claimed_at_ms INTEGER,
      finished_at_ms INTEGER,
      outcome INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT '',
      exit_code INTEGER NOT NULL DEFAULT 0
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS resume_requests_pending_idx ON resume_requests (machine, os_user, finished_at_ms, requested_at_ms)`,
  sql`CREATE INDEX IF NOT EXISTS resume_requests_requested_at_idx ON resume_requests (requested_at_ms)`,
];
