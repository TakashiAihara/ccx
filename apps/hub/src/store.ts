import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

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
};

/**
 * SQLite のホスト変数の上限 (32766) に対する余裕を見た刻み幅。1 行 12 列なので
 * 500 行で 6000 個。ccxd は今のところ 1 件ずつ送ってくるが、契約は複数件を許して
 * いるので、送り手が変わっても壊れないところに置いておく。
 */
const CHUNK = 500;

/**
 * バッチを 1 トランザクションで入れる。返すのは「新規に保存された件数」。
 *
 * 全か無か (ingest.proto)。1 件でも失敗したら例外が投げられ、トランザクションごと
 * 巻き戻る。ccxd はこの all-or-nothing に乗って spool を消すので、部分的に保存して
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
 */
export function listSessions(db: Db, f: ListSessionsFilter): SessionRow[] {
  const where: SQL[] = [sql`session_id != ''`];
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
  }));
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

export function listEvents(db: Db, f: ListEventsFilter): StoredEvent[] {
  const where: SQL[] = [];
  if (f.machine) where.push(eq(events.machine, f.machine));
  if (f.user) where.push(eq(events.user, f.user));
  if (f.sessionId) where.push(eq(events.sessionId, f.sessionId));
  if (f.hookEventName) where.push(eq(events.hookEventName, f.hookEventName));
  // since は含み、until は含まない (fleet.proto)。境界の event が両方の窓に
  // 出るのを避ける。
  if (f.sinceMs !== undefined) where.push(gte(events.receivedAtMs, f.sinceMs));
  if (f.untilMs !== undefined) where.push(lt(events.receivedAtMs, f.untilMs));

  const rows = db
    .select()
    .from(events)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(events.receivedAtMs), desc(events.seq))
    .limit(f.limit)
    .all();

  return rows.map((r) => ({
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
    payload: f.includePayload ? new Uint8Array(r.payload as Buffer) : null,
  }));
}
