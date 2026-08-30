import { timestampDate, timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";

import type { Db } from "./db/open.ts";
import { IngestService } from "@ccx/proto/ccx/v1/ingest_pb.ts";
import { FleetService } from "@ccx/proto/ccx/v1/fleet_pb.ts";
import { ingest, listEvents, listSessions, type IncomingEvent } from "./store.ts";

/** fleet.proto の既定と上限。0 は「指定なし」なので既定に落ちる。 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function clampLimit(v: number): number {
  if (!v) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

export function ingestImpl(db: Db): ServiceImpl<typeof IngestService> {
  return {
    ingest(req) {
      const batch: IncomingEvent[] = req.events.map((e) => {
        // event_id はこの先ずっと同一性の軸になる。無いまま入れると重複排除が
        // 効かず、再送のたびに行が増える。バッチごと弾く (all-or-nothing)。
        if (!e.eventId) {
          throw new ConnectError("event_id is required", Code.InvalidArgument);
        }
        if (!e.origin?.machine || !e.origin.user) {
          throw new ConnectError(
            `event ${e.eventId}: origin.machine and origin.user are required`,
            Code.InvalidArgument,
          );
        }
        return {
          eventId: e.eventId,
          machine: e.origin.machine,
          user: e.origin.user,
          seq: Number(e.seq),
          // ccxd が received_at を付けそこねた場合だけ center の時計に落ちる。
          // 時刻を持たない行を作るより、どちらの時計かが分かる形で埋めるほうがよい。
          receivedAtMs: e.receivedAt ? timestampDate(e.receivedAt).getTime() : Date.now(),
          producer: e.producer,
          payload: e.payload,
        };
      });

      // ingest は 1 トランザクション。例外が出れば 1 件も保存されない。
      return { accepted: ingest(db, batch) };
    },
  };
}

export function fleetImpl(db: Db): ServiceImpl<typeof FleetService> {
  return {
    listSessions(req) {
      const rows = listSessions(db, {
        machine: req.machine || undefined,
        user: req.user || undefined,
        activeOnly: req.activeOnly,
        limit: clampLimit(req.limit),
      });

      return {
        sessions: rows.map((s) => ({
          $typeName: "ccx.v1.Session" as const,
          key: {
            $typeName: "ccx.v1.SessionKey" as const,
            machine: s.machine,
            user: s.user,
            sessionId: s.sessionId,
          },
          firstSeen: timestampFromMs(s.firstSeenMs),
          lastSeen: timestampFromMs(s.lastSeenMs),
          endedAt: s.endedAtMs === null ? undefined : timestampFromMs(s.endedAtMs),
          cwd: s.cwd,
          transcriptPath: s.transcriptPath,
          eventCount: BigInt(s.eventCount),
          lastHook: s.lastHook,
        })),
      };
    },

    listEvents(req) {
      const rows = listEvents(db, {
        machine: req.machine || undefined,
        user: req.user || undefined,
        sessionId: req.sessionId || undefined,
        hookEventName: req.hookEventName || undefined,
        sinceMs: req.since ? timestampDate(req.since).getTime() : undefined,
        untilMs: req.until ? timestampDate(req.until).getTime() : undefined,
        includePayload: req.includePayload,
        limit: clampLimit(req.limit),
      });

      return {
        events: rows.map((e) => ({
          $typeName: "ccx.v1.EventRecord" as const,
          eventId: e.eventId,
          machine: e.machine,
          user: e.user,
          seq: BigInt(e.seq),
          receivedAt: timestampFromMs(e.receivedAtMs),
          parsed: e.parsed,
          sessionId: e.sessionId,
          hookEventName: e.hookEventName,
          cwd: e.cwd,
          payload: e.payload ?? new Uint8Array(0),
        })),
      };
    },
  };
}
