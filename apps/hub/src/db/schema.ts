import { sql } from "drizzle-orm";
import { blob, check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 集めた event を 1 行 1 件で持つテーブル。
 *
 * 生 payload を必ず残し、派生値 (session_id / hook_event_name / cwd /
 * transcript_path) は同じ行の隣に置く。派生値を別テーブルに切らないのは、
 * 「導出をやり直せる」ことがこの設計の核だから (ingest.proto)。行が 1 つなら、
 * パーサを直したあとに全行を読み直して埋め直せる。
 *
 * session の真実源も events。一覧用の session_summary は events から作り直せる写しで、
 * 食い違ったら events が正 (#307 で件数が効いてきたので写しを持った)。
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
    // 1 session の履歴と、宣言状態の最新 1 件 (latestStates)。
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
 * (machine, user) の「動いている session の一覧」 (#261)。producer が 3 の event はここに上書きで入る。
 *
 * events に積まないのは、一覧が「今」の写しだから (ingest.proto)。積むと行が増えて、
 * 過去の一覧まで「動いていた証拠」として読めてしまう。received_at_ms は center が受け取った
 * 時刻 (center の時計) で、agent が送ってきた時刻は使わない。
 */
export const agentRunning = sqliteTable(
  "agent_running",
  {
    machine: text("machine").notNull(),
    // "user" は events と同じ理由で列名を分ける
    user: text("os_user").notNull(),
    // JSON 配列 ("[\"<session id>\", ...]")。id を 1 行に分けないのは、1 行が 1 つの写しだから
    sessionIds: text("session_ids").notNull(),
    // center が受け取った時刻 (center の時計)
    receivedAtMs: integer("received_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.machine, t.user] })],
);

/**
 * 各 (machine, user) の ccx-agent が一覧に載せて送ってきた、起こしの合図の宛先 (#261)。
 *
 * agent_running に列を足さないのは、動いている center の DB に ALTER が要らないように。
 * 宛先は一覧と同じ時に入れ替わるので、received_at_ms も一覧と同じ center の時計で持つ。
 */
export const agentEndpoints = sqliteTable(
  "agent_endpoints",
  {
    machine: text("machine").notNull(),
    user: text("os_user").notNull(),
    apiUrl: text("api_url").notNull(),
    receivedAtMs: integer("received_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.machine, t.user] })],
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

    // 最後に取った ccx-agent に渡した印。取るたびに振り直し、取り直された後の古い結果を断る
    claimToken: text("claim_token").notNull().default(""),
    // 相手に `ccx session resume --wait` へ渡す秒数。0 なら相手の既定
    waitSeconds: integer("wait_seconds").notNull().default(0),
  },
  (t) => [
    // Claim が「まだ誰にも渡っていない最古の 1 件」を探す窓。
    index("resume_requests_pending_idx").on(t.machine, t.user, t.finishedAtMs, t.requestedAtMs),
    // 一覧の requested_at の新しい順。
    index("resume_requests_requested_at_idx").on(t.requestedAtMs),
  ],
);

/**
 * スキーマの DDL。drizzle-kit の migration ファイルを使わないのは、どれも CREATE ... IF NOT EXISTS で
 * center が起動時に自分で用意できる範囲だから。既存の表に列を足す変更が要るようになったらそのとき入れる
 * (agent_endpoints を agent_running の列にしなかったのはこのため)。
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
    CREATE TABLE IF NOT EXISTS agent_running (
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      session_ids TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      PRIMARY KEY (machine, os_user)
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS agent_endpoints (
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      api_url TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      PRIMARY KEY (machine, os_user)
    )
  `,
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
      exit_code INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT NOT NULL DEFAULT '',
      wait_seconds INTEGER NOT NULL DEFAULT 0
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS resume_requests_pending_idx ON resume_requests (machine, os_user, finished_at_ms, requested_at_ms)`,
  sql`CREATE INDEX IF NOT EXISTS resume_requests_requested_at_idx ON resume_requests (requested_at_ms)`,
  sql`
    CREATE TABLE IF NOT EXISTS relay_messages (
      id TEXT PRIMARY KEY,
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      request BLOB NOT NULL,
      put_at_ms INTEGER NOT NULL,
      claimed_at_ms INTEGER,
      finished_at_ms INTEGER,
      acks TEXT NOT NULL DEFAULT '[]',
      error_code INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      not_typed INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT NOT NULL DEFAULT ''
    )
  `,
  // hook の event (Producer.CLAUDE_CODE_HOOK) から導いた session ごとの集計で、ListSessions はこれだけを読む (#307)。events を毎回
  // window 集計すると 80 万行 (3 GB) で 1 回 20〜40 秒かかり、bun:sqlite は同期なので center の全リクエストが止まった。
  // ingest が同じトランザクションで更新し (store.ts の summarize)、表が無ければ起動時に events から作る (open.ts)。
  // last_seq は last_seen_ms が同じ event どうしで、cwd / transcript_path / last_hook をどれから取るかを決める
  sql`
    CREATE TABLE IF NOT EXISTS session_summary (
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      session_id TEXT NOT NULL,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      ended_at_ms INTEGER,
      event_count INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      last_hook TEXT NOT NULL,
      PRIMARY KEY (machine, os_user, session_id)
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS session_summary_last_seen_idx ON session_summary (last_seen_ms)`,
  sql`CREATE INDEX IF NOT EXISTS relay_messages_pending_idx ON relay_messages (machine, os_user, claimed_at_ms, put_at_ms)`,
  sql`CREATE INDEX IF NOT EXISTS relay_messages_put_at_idx ON relay_messages (put_at_ms)`,
  sql`
    CREATE TABLE IF NOT EXISTS relay_receivers (
      machine TEXT NOT NULL,
      os_user TEXT NOT NULL,
      claimed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (machine, os_user)
    )
  `,
];

/**
 * 別マシンの ccx-agent へ運ぶメッセージ (#138、message.proto の MessageRelayService)。送り手の ccx-agent が
 * 置いて ack を読み返し、宛先の ccx-agent が取りに来て、届けた ack を書く。
 *
 * resume_requests と違い、取られた行は二度と渡さない (取り直しが無い)。届けた途中で落ちた agent の分を
 * 渡し直すと、同じ本文が 2 度打たれるため。
 */
export const relayMessages = sqliteTable(
  "relay_messages",
  {
    // center が振る UUIDv7。
    id: text("id").primaryKey(),
    // 宛先。送り手が名指しした値で、取りに来た agent の origin と照合する。
    machine: text("machine").notNull(),
    user: text("os_user").notNull(),
    // ccx.v1.SendRequest をそのまま protobuf のバイト列で持つ。中身は宛先の agent が検める。
    request: blob("request", { mode: "buffer" }).notNull(),
    putAtMs: integer("put_at_ms").notNull(),
    claimedAtMs: integer("claimed_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    // ccx.v1.SendResponse の列を JSON で ([{state, detail}])。報告のたびに丸ごと置き換える (保存済みより短い報告では置き換えない)。
    acks: text("acks").notNull().default("[]"),
    errorCode: integer("error_code").notNull().default(0),
    errorMessage: text("error_message").notNull().default(""),
    notTyped: integer("not_typed", { mode: "boolean" }).notNull().default(false),
    claimToken: text("claim_token").notNull().default(""),
  },
  (t) => [index("relay_messages_pending_idx").on(t.machine, t.user, t.claimedAtMs, t.putAtMs), index("relay_messages_put_at_idx").on(t.putAtMs)],
);

/**
 * メッセージを取りに来たことのある (machine, user) (#319)。宛先がここに無ければ、置いても取る agent が居ないので
 * 送り手を待たせずに断る。agent_running (一覧) で見ないのは、一覧を送るのは resume で、ccx の CLI が無い・Claude home
 * が読めない agent は一覧を送らずに受信だけするから。取りに来るのは受信する agent だけで、古い agent も取りに来る
 */
export const relayReceivers = sqliteTable(
  "relay_receivers",
  {
    machine: text("machine").notNull(),
    user: text("os_user").notNull(),
    // 最初に取りに来た時刻 (center の時計)。判定には使わず、いつから居るかを後から見るため
    claimedAtMs: integer("claimed_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.machine, t.user] })],
);
