import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

import { Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

import type { Db } from "./db/open.ts";
import { events } from "./db/schema.ts";
import { derive } from "./derive.ts";

export type IncomingEvent = {
  eventId: string;
  machine: string;
  user: string;
  seq: number;
  receivedAtMs: number;
  producer: number;
  payload: Uint8Array;
};

export type StoredEvent = {
  eventId: string;
  machine: string;
  user: string;
  seq: number;
  receivedAtMs: number;
  producer: number;
  parsed: boolean;
  sessionId: string;
  hookEventName: string;
  cwd: string;
  transcriptPath: string;
  payload: Uint8Array | null;
};

export type SessionRow = {
  machine: string;
  user: string;
  sessionId: string;
  firstSeenMs: number;
  lastSeenMs: number;
  endedAtMs: number | null;
  cwd: string;
  transcriptPath: string;
  lastHook: string;
  eventCount: number;
  /** 最後に届いた宣言状態 (Producer.CCX_SESSION_STATE)。1 件も無ければ null */
  state: SessionState | null;
};

export type SessionState = {
  archived: boolean;
  label: string;
  task: string;
  /** 利用者の key/value。center は意味を持たずに運ぶ (#165)。core の META_KEY に合わない key と string でない値は落とす */
  metadata: Record<string, string>;
};



/**
 * SQLite のホスト変数の上限 (32766) に対する余裕を見た刻み幅。1 行 12 列なので
 * 500 行で 6000 個。ccx-agent は今のところ 1 件ずつ送ってくるが、契約は複数件を許して
 * いるので、送り手が変わっても壊れないところに置いておく。
 */
const CHUNK = 500;

/**
 * バッチを 1 トランザクションで入れる。返すのは「新規に保存された件数」。
 *
 * 全か無か (ingest.proto)。1 件でも失敗したら例外が投げられ、トランザクションごと
 * 巻き戻る。ccx-agent はこの all-or-nothing に乗って spool を消すので、部分的に保存して
 * 成功を返すことがあってはならない。
 *
 * 既知の event_id は黙って捨てる。転送は at-least-once なので、二度届くのは
 * 異常ではなく正常系。
 */
export function ingest(db: Db, batch: IncomingEvent[]): number {
  if (batch.length === 0) return 0;

  const rows = batch.map((e) => {
    const d = derive(e.payload);
    return {
      eventId: e.eventId,
      machine: e.machine,
      user: e.user,
      seq: e.seq,
      receivedAtMs: e.receivedAtMs,
      producer: e.producer,
      payload: Buffer.from(e.payload),
      parsed: d.parsed,
      sessionId: d.sessionId,
      hookEventName: d.hookEventName,
      cwd: d.cwd,
      transcriptPath: d.transcriptPath,
    };
  });

  return db.transaction((tx) => {
    let accepted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const inserted = tx
        .insert(events)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoNothing()
        .returning({ id: events.eventId })
        .all();
      accepted += inserted.length;
    }
    return accepted;
  });
}

export type ListSessionsFilter = {
  machine?: string;
  user?: string;
  activeOnly?: boolean;
  limit: number;
};

/**
 * session を event から導く。session テーブルを持たないので、パーサを直せば
 * 一覧もその場で直る。
 *
 * 各 session の「最後に観測した値」(cwd / transcript_path / last_hook) は
 * ROW_NUMBER で最後の 1 行を選んで取る。SQLite には「MIN/MAX と同じ行の裸の列が
 * 取れる」という方言があるが、MIN と MAX を同時に使うと、どちらの行が選ばれるかは
 * 決まらない。方言に寄りかからずに書く。
 *
 * session の統計 (first / last seen、件数、last hook) は hook の event (CLAUDE_CODE_HOOK)
 * だけから作る。宣言状態 (CCX_SESSION_STATE) は混ぜず、一覧に載った session ごとに最新の
 * 1 件を別に引く (#127)。印だけ届いて hook が 1 件も無い session は一覧に出ない —
 * center が一覧するのは hook が観測した session で、印はその属性 (ccx-agent が配線されて
 * いないマシンの印は届いても見えない)。印が後から立っても last_seen は動かない。
 */
export function listSessions(db: Db, f: ListSessionsFilter): SessionRow[] {
  const where: SQL[] = [sql`session_id != ''`, sql`producer = ${Producer.CLAUDE_CODE_HOOK}`];
  if (f.machine) where.push(sql`machine = ${f.machine}`);
  if (f.user) where.push(sql`os_user = ${f.user}`);

  // 外側の rn = 1 に続けるので AND。ここを WHERE にすると SQL が二重になる。
  const activeOnly = f.activeOnly ? sql`AND ended_at_ms IS NULL` : sql``;

  const rows = db.all<{
    machine: string;
    os_user: string;
    session_id: string;
    first_seen_ms: number;
    last_seen_ms: number;
    ended_at_ms: number | null;
    cwd: string;
    transcript_path: string;
    last_hook: string;
    event_count: number;
  }>(sql`
    SELECT machine, os_user, session_id, first_seen_ms, last_seen_ms, ended_at_ms,
           cwd, transcript_path, last_hook, event_count
    FROM (
      SELECT
        machine, os_user, session_id, cwd, transcript_path,
        hook_event_name AS last_hook,
        MIN(received_at_ms) OVER w AS first_seen_ms,
        MAX(received_at_ms) OVER w AS last_seen_ms,
        COUNT(*) OVER w AS event_count,
        MAX(CASE WHEN hook_event_name = 'SessionEnd' THEN received_at_ms END) OVER w AS ended_at_ms,
        ROW_NUMBER() OVER (
          PARTITION BY machine, os_user, session_id
          ORDER BY received_at_ms DESC, seq DESC
        ) AS rn
      FROM events
      WHERE ${sql.join(where, sql` AND `)}
      WINDOW w AS (PARTITION BY machine, os_user, session_id)
    )
    WHERE rn = 1 ${activeOnly}
    ORDER BY last_seen_ms DESC
    LIMIT ${f.limit}
  `);

  const states = latestStates(db, rows);
  return rows.map((r) => ({
    machine: r.machine,
    user: r.os_user,
    sessionId: r.session_id,
    firstSeenMs: r.first_seen_ms,
    lastSeenMs: r.last_seen_ms,
    endedAtMs: r.ended_at_ms,
    cwd: r.cwd,
    transcriptPath: r.transcript_path,
    lastHook: r.last_hook,
    eventCount: r.event_count,
    state: states.get(`${r.machine}\0${r.os_user}\0${r.session_id}`) ?? null,
  }));
}

/**
 * 一覧の session ごとに、最新の「読める」宣言状態を 1 件だけ返す (履歴を全部は読まない)。
 *
 * - 読めない payload は無いものとして扱う — 最新が読めなければその前の読める 1 件
 *   (読めない event を墓標にしない)
 * - 「最新」は送り手が付けた `rev` (その machine の CLI が送る直前の時刻 ms)。1 つの
 *   (machine, user, session) の中では同じ時計なので比べられる。到着順だけで決めると、
 *   先に書いて遅れて届いた古い写しが後から勝つ。rev が同じ (同じ ms) か無い (rev を
 *   送らない版) ときだけ到着順 (rowid)
 */
function latestStates(db: Db, keys: { machine: string; os_user: string; session_id: string }[]): Map<string, SessionState> {
  const out = new Map<string, SessionState>();
  if (keys.length === 0) return out;
  const tuples = keys.map((k) => sql`(${k.machine}, ${k.os_user}, ${k.session_id})`);
  const rows = db.all<{ machine: string; os_user: string; session_id: string; payload: string }>(sql`
    SELECT machine, os_user, session_id, payload
    FROM (
      SELECT machine, os_user, session_id, doc AS payload,
             ROW_NUMBER() OVER (
               PARTITION BY machine, os_user, session_id
               ORDER BY coalesce(json_extract(doc, '$.rev'), 0) DESC, rid DESC
             ) AS rn
      FROM (
        SELECT machine, os_user, session_id, rowid AS rid, CAST(payload AS TEXT) AS doc
        FROM events
        WHERE producer = ${Producer.CCX_SESSION_STATE} AND (machine, os_user, session_id) IN (${sql.join(tuples, sql`, `)})
      )
      WHERE json_valid(doc) AND json_type(doc, '$.state') = 'object'
    )
    WHERE rn = 1
  `);
  for (const r of rows) {
    const s = parseState(new TextEncoder().encode(r.payload));
    if (s) out.set(`${r.machine}\0${r.os_user}\0${r.session_id}`, s);
  }
  return out;
}

/** packages/core/src/session-state.ts の META_KEY と同じ (hub は core に依存しない)。形の崩れた key を index に溜めない */
const META_KEY = /^[a-z0-9_][a-z0-9_.-]{0,127}$/;

function parseState(payload: Uint8Array): SessionState | null {
  try {
    const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as { state?: Record<string, unknown> };
    const s = o?.state;
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    return {
      archived: s.archived === true,
      label: typeof s.label === "string" ? s.label : "",
      task: typeof s.task === "string" ? s.task : "",
      metadata:
        s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata)
          ? Object.fromEntries(Object.entries(s.metadata).filter(([k, v]) => META_KEY.test(k) && typeof v === "string"))
          : {},
    };
  } catch {
    return null;
  }
}

export type ListEventsFilter = {
  machine?: string;
  user?: string;
  sessionId?: string;
  hookEventName?: string;
  sinceMs?: number;
  untilMs?: number;
  includePayload: boolean;
  limit: number;
};

/**
 * SELECT を組み立てるところだけを切り出してある。payload を要求されていないときに
 * 列そのものを SELECT していないことは、返り値からは確かめられない (どちらでも
 * payload は null になる)。組み立てた SQL を見るしかないので、そこに触れる口を
 * 開けておく。
 */
export function listEventsQuery(db: Db, f: ListEventsFilter) {
  const where: SQL[] = [];
  if (f.machine) where.push(eq(events.machine, f.machine));
  if (f.user) where.push(eq(events.user, f.user));
  if (f.sessionId) where.push(eq(events.sessionId, f.sessionId));
  if (f.hookEventName) where.push(eq(events.hookEventName, f.hookEventName));
  // since は含み、until は含まない (fleet.proto)。境界の event が両方の窓に
  // 出るのを避ける。
  if (f.sinceMs !== undefined) where.push(gte(events.receivedAtMs, f.sinceMs));
  if (f.untilMs !== undefined) where.push(lt(events.receivedAtMs, f.untilMs));

  // payload を要求されていないなら、列そのものを SELECT しない。select() を引数
  // 無しで呼ぶと SELECT * になり、SQLite は捨てるだけの BLOB を全行ぶん読む。
  // limit 1000 x 数十 KB で、返さない値のために数十 MB を読むことになる。
  const columns = {
    eventId: events.eventId,
    machine: events.machine,
    user: events.user,
    seq: events.seq,
    receivedAtMs: events.receivedAtMs,
    producer: events.producer,
    parsed: events.parsed,
    sessionId: events.sessionId,
    hookEventName: events.hookEventName,
    cwd: events.cwd,
    transcriptPath: events.transcriptPath,
  };

  return db
    .select(f.includePayload ? { ...columns, payload: events.payload } : columns)
    .from(events)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(events.receivedAtMs), desc(events.seq))
    .limit(f.limit);
}

export function listEvents(db: Db, f: ListEventsFilter): StoredEvent[] {
  return listEventsQuery(db, f).all().map((r) => ({
    eventId: r.eventId,
    machine: r.machine,
    user: r.user,
    seq: r.seq,
    receivedAtMs: r.receivedAtMs,
    producer: r.producer,
    parsed: r.parsed,
    sessionId: r.sessionId,
    hookEventName: r.hookEventName,
    cwd: r.cwd,
    transcriptPath: r.transcriptPath,
    // 既定で載せないのは PostToolUse の payload が数十 KB になるため
    // (fleet.proto)。一覧が読めなくなる。
    payload: "payload" in r && r.payload ? new Uint8Array(r.payload as Buffer) : null,
  }));
}
