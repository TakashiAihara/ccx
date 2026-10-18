import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";

import { Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

import type { Db } from "./db/open.ts";
import { agentEndpoints, agentRunning, events } from "./db/schema.ts";
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
  /** その (machine, user) の最新の「動いている一覧」から読んだ状態 (#261) */
  liveness: "running" | "stopped" | "unknown";
};

export type SessionState = {
  archived: boolean;
  label: string;
  task: string;
  role: string;
  /** 利用者の key/value。center は意味を持たずに運ぶ (#165)。core の META_KEY に合わない key と string でない値は落とす */
  metadata: Record<string, string>;
};

/** (machine, user) の、まだ新しい「動いている session の一覧」 (#261) */
type RunningList = Set<string>;

/**
 * 読めない「動いている一覧」をバッチごと断る時に投げる。読めない一覧を「何も動いて
 * いない」として持つのは、一覧の無い (machine, user) を unknown にするのと同じ扱い
 * になってしまうから (ingest.proto)
 */
export class UnreadableRunningList extends Error {
  constructor(eventId: string) {
    super(`event ${eventId}: the running session list is not {"session_ids": ["..."]}`);
    this.name = "UnreadableRunningList";
  }
}

/**
 * SQLite のホスト変数の上限 (32766) に対する余裕を見た刻み幅。1 行 12 列なので
 * 500 行で 6000 個。ccx-agent は今のところ 1 件ずつ送ってくるが、契約は複数件を許して
 * いるので、送り手が変わっても壊れないところに置いておく。
 */
const CHUNK = 500;

/**
 * 「動いている session の一覧」(Producer.CCX_AGENT_RUNNING) を新しいとみなす窓 (#261)。
 *
 * 一覧は ccx-agent が送る。送られなくなった (machine, user) については、session が
 * 止まったとも動いているとも言えないので、stopped ではなく unknown に落とす。
 */
export const RUNNING_FRESH_MS = 5 * 60 * 1000;

/**
 * バッチを 1 トランザクションで入れる。返すのは「新規に保存された件数」。
 *
 * 全か無か (ingest.proto)。1 件でも失敗したら例外が投げられ、トランザクションごと
 * 巻き戻る。ccx-agent はこの all-or-nothing に乗って spool を消すので、部分的に保存して
 * 成功を返すことがあってはならない。
 *
 * 既知の event_id は黙って捨てる。転送は at-least-once なので、二度届くのは
 * 異常ではなく正常系。
 *
 * 「動いている一覧」(Producer.CCX_AGENT_RUNNING) だけは events に入れない。1 件ごとに
 * (machine, user) の行を上書きし、受け取った時刻は center の時計 (nowMs) で持つ。
 */
export function ingest(db: Db, batch: IncomingEvent[], nowMs = Date.now()): number {
  if (batch.length === 0) return 0;

  const lists = batch.filter((e) => e.producer === Producer.CCX_AGENT_RUNNING);
  const rows = batch
    .filter((e) => e.producer !== Producer.CCX_AGENT_RUNNING)
    .map((e) => {
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
    // 同じ (machine, user) が同じバッチに 2 つあれば、後のものが残る
    for (const l of lists) {
      const ids = JSON.stringify(parseSessionIds(l));
      tx.insert(agentRunning)
        .values({ machine: l.machine, user: l.user, sessionIds: ids, receivedAtMs: nowMs })
        .onConflictDoUpdate({
          target: [agentRunning.machine, agentRunning.user],
          set: { sessionIds: ids, receivedAtMs: nowMs },
        })
        .run();
      // 宛先が読めないことは一覧を断る理由にしない。古い宛先を残すと別の場所へ起こしに行くので消す
      const apiUrl = apiURLOf(l);
      if (apiUrl === null) {
        tx.delete(agentEndpoints)
          .where(and(eq(agentEndpoints.machine, l.machine), eq(agentEndpoints.user, l.user)))
          .run();
      } else {
        tx.insert(agentEndpoints)
          .values({ machine: l.machine, user: l.user, apiUrl, receivedAtMs: nowMs })
          .onConflictDoUpdate({
            target: [agentEndpoints.machine, agentEndpoints.user],
            set: { apiUrl, receivedAtMs: nowMs },
          })
          .run();
      }
      accepted += 1;
    }
    return accepted;
  });
}

/**
 * 一覧が名指しする起こしの宛先 (#261)。origin (scheme://host[:port]) だけを通し、正規化した形で返す。
 * center は RPC の path を足して token を送るので、path / query / fragment / userinfo があると送り先を一覧が決めてしまう。
 * 無い・文字列でない・不正なものは null。parseSessionIds の後に呼ぶので、payload は JSON と分かっている
 */
function apiURLOf(l: IncomingEvent): string | null {
  const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(l.payload)) as { api_url?: unknown };
  const raw = o.api_url;
  if (typeof raw !== "string") return null;
  // new URL は "http://host?" の空の query を捨てるので、記号は文字列で見る
  if (/[?#]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.pathname === "/" &&
      u.username === "" &&
      u.password === ""
    ) {
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    // 相対や scheme の無い文字列は URL にならない。下で null
  }
  return null;
}

/** 一覧は `{"session_ids": ["...", ...]}` で、それ以外の形は読めていないとみなす */
function parseSessionIds(l: IncomingEvent): string[] {
  try {
    const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(l.payload)) as { session_ids?: unknown };
    if (Array.isArray(o?.session_ids) && o.session_ids.every((v) => typeof v === "string")) {
      return o.session_ids;
    }
  } catch {
    // 下の Error に落とす
  }
  throw new UnreadableRunningList(l.eventId);
}

export type ListSessionsFilter = {
  machine?: string;
  user?: string;
  activeOnly?: boolean;
  limit: number;
  /** liveness の判定に使う時計。既定は center の時計 */
  nowMs?: number;
  /** stopped で archived でないものだけを返す */
  stoppedOnly?: boolean;
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
 *
 * 「動いているか」(#261) も同じ考え方で別に引く。宣言状態と同じく hook の集計には
 * 混ぜない — 動いている一覧は session の状態であって、その session が何をした記録
 * ではない。件数も last_seen も動かさない。
 */
export function listSessions(db: Db, f: ListSessionsFilter): SessionRow[] {
  const where: SQL[] = [sql`session_id != ''`, sql`producer = ${Producer.CLAUDE_CODE_HOOK}`];
  if (f.machine) where.push(sql`machine = ${f.machine}`);
  if (f.user) where.push(sql`os_user = ${f.user}`);

  // 外側の rn = 1 に続けるので AND。ここを WHERE にすると SQL が二重になる。
  const activeOnly = f.activeOnly ? sql`AND ended_at_ms IS NULL` : sql``;

  // stoppedOnly を絞るには宣言状態 (下のクエリ) が要る。SQL 側で limit を効かせると、
  // 開かない session が枠を占めたまま「候補が無い」ことになるので、このときだけ limit
  // を外して全部読み、JS で絞ってから limit を切る。
  const limit = f.stoppedOnly ? sql`` : sql`LIMIT ${f.limit}`;

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
    ${limit}
  `);

  const nowMs = f.nowMs ?? Date.now();
  const states = latestStates(db, rows);
  const lists = freshRunning(db, rows, nowMs);
  const sessions = rows.map((r) => ({
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
    liveness: livenessOf(lists.get(`${r.machine}\0${r.os_user}`), r.session_id),
  }));

  if (!f.stoppedOnly) return sessions;
  return sessions.filter((s) => s.liveness === "stopped" && s.state?.archived !== true).slice(0, f.limit);
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
  // stoppedOnly では全件がここに来るので、IN (...) を 1 つにまとめない。bun の SQLite は 1 文に 25 万個まで
  // 変数を受けた (2026-10-18 実測、250001 個で too many SQL variables)。1 件に 3 個使うので、約 8.3 万 session で届く
  for (let i = 0; i < keys.length; i += CHUNK) {
    const tuples = keys.slice(i, i + CHUNK).map((k) => sql`(${k.machine}, ${k.os_user}, ${k.session_id})`);
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
  }
  return out;
}

/**
 * (machine, user) ごとに、まだ新しい「動いている一覧」を 1 件だけ返す (古いのは読まない)。
 *
 * agent_running は 1 行が最新の写しなので、履歴を辿る必要は無い。鮮度は SQL 側で切る。
 * 返り値に無い (machine, user) には一覧が届いていないので unknown になる
 */
function freshRunning(db: Db, keys: { machine: string; os_user: string }[], nowMs: number): Map<string, RunningList> {
  const out = new Map<string, RunningList>();
  const tuples: SQL[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const key = `${k.machine}\0${k.os_user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tuples.push(sql`(${k.machine}, ${k.os_user})`);
  }
  // (machine, user) は重複を除いてあるので数はマシンとユーザーの数だけだが、latestStates と同じく分けて引く
  for (let i = 0; i < tuples.length; i += CHUNK) {
    const rows = db.all<{ machine: string; os_user: string; session_ids: string }>(sql`
      SELECT machine, os_user, session_ids
      FROM agent_running
      WHERE received_at_ms >= ${nowMs - RUNNING_FRESH_MS}
        AND (machine, os_user) IN (${sql.join(tuples.slice(i, i + CHUNK), sql`, `)})
    `);
    for (const r of rows) {
      out.set(`${r.machine}\0${r.os_user}`, new Set(parseIds(r.session_ids)));
    }
  }
  return out;
}

/** 一覧は center が JSON の配列として書き込んだ値。読めないものを「何もない」とは言わない */
function parseIds(sessionIds: string): string[] {
  const v = JSON.parse(sessionIds) as unknown;
  if (!Array.isArray(v) || !v.every((id) => typeof id === "string")) {
    throw new Error(`agent_running.session_ids is not an array of strings: ${sessionIds}`);
  }
  return v;
}

/** 一覧が無い (machine, user) のときは unknown。止まったとは言わない */
function livenessOf(ids: RunningList | undefined, sessionId: string): SessionRow["liveness"] {
  if (!ids) return "unknown";
  return ids.has(sessionId) ? "running" : "stopped";
}

/**
 * packages/core/src/session-state.ts の META_KEY と同じ (hub は core に依存しない)。events には
 * 届いた payload のまま残る。落とすのは読むとき: 形の崩れた key を ListSessions で返さない
 */
const META_KEY = /^[a-z0-9_][a-z0-9_.-]{0,127}$/;
/** packages/core/src/session-state.ts の ROLE と同じ。合わない role は「無い」として持つ */
const ROLE = /^[^\p{Cc}\u2028\u2029]*$/u;

function parseState(payload: Uint8Array): SessionState | null {
  try {
    const o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as { state?: Record<string, unknown> };
    const s = o?.state;
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    return {
      archived: s.archived === true,
      label: typeof s.label === "string" ? s.label : "",
      task: typeof s.task === "string" ? s.task : "",
      role: typeof s.role === "string" && ROLE.test(s.role) ? s.role : "",
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
