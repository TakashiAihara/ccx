import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";

import { validBucket, validPrefix, type ObjectStore } from "./objects.ts";
import { AppendResponseSchema, TranscriptService } from "@ccx/proto/ccx/v1/transcript_pb.ts";

/**
 * transcript.proto の実装 (#120、docs/design/live-transcript.md)。
 *
 * 走っている session の transcript.jsonl を作っている ccx-agent が、offset を携えて
 * bytes を足してくる。center が見るのは「その key の今の size と offset が一致するか」
 * だけなので、本文の中身は中心には読まない。足す先は `ccx transcript` が pull / prune /
 * search で読んでいるのと同じ object なので、読む側が見えるものは変わらない。
 */

/** Claude Code の session id の形。key に入る値なので、この検査を通るまで何の仮定にも使わない */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NEWLINE = 0x0a;

const invalid = (why: string): ConnectError => new ConnectError(why, Code.InvalidArgument);

/**
 * key の一部になる machine / user。どちらも key の 1 セグメントなので、空と `.` / `..`
 * (その先を読んでしまう) と `/` (セグメントを割る) をここで落とす。
 */
function validSegment(v: string): boolean {
  return v !== "" && v !== "." && v !== ".." && !v.includes("/");
}

/** 保存先の key。`ccx transcript` が読むものと一字ずつ同じにする */
export function transcriptKey(prefix: string, machine: string, user: string, sessionId: string): string {
  return `${prefix}transcripts/machine=${machine}/user=${user}/session_id=${sessionId}/transcript.jsonl`;
}

export function transcriptImpl(objects: ObjectStore): ServiceImpl<typeof TranscriptService> {
  return {
    async append(req) {
      // key になる値を先に検めてから、1 byte も書かない。書き込みが成り立つのは
      // 「offset が今の size と一致したとき」だけなので、size の判定は検査の後になる
      const origin = req.origin;
      if (!origin) throw invalid("origin is required");
      if (!validSegment(origin.machine) || !validSegment(origin.user)) {
        throw invalid("origin.machine and origin.user must be non-empty and hold neither '/' nor '.'");
      }
      if (!SESSION_ID.test(req.sessionId)) throw invalid(`session_id is not a session id: ${req.sessionId}`);
      if (!validBucket(req.bucket)) throw invalid(`bucket is not a bucket name: ${req.bucket}`);
      // prefix は key の先頭。空か `/` で終わるものだけ取る。`lead` は「lead/ の親」を
      // 指す省略としてここで切らない (config 側で `ccx transcript` と同じ形に正規化される)
      if ((req.prefix !== "" && !req.prefix.endsWith("/")) || !validPrefix(req.prefix)) {
        throw invalid(`prefix must be empty or end with '/': ${req.prefix}`);
      }
      // 書きかけの行を渡すと、object の末尾が次の append で壊れたままになる。whole line だけ
      if (req.data.length > 0 && req.data[req.data.length - 1] !== NEWLINE) {
        throw invalid("data does not end with a newline");
      }

      const key = transcriptKey(req.prefix, origin.machine, origin.user, req.sessionId);
      const res = await objects.append(req.bucket, key, req.offset, req.data);
      if (res.ok) return { $typeName: "ccx.v1.AppendResponse" as const, size: res.size };

      // 断った。size を detail に入れて返すと、送り手は自分の offset を手元に持たなくて
      // 済む (再起動したら 0 から送り、断られた size から続ける)
      throw new ConnectError(
        `offset ${req.offset} is not the object's size ${res.size}`,
        Code.FailedPrecondition,
        undefined,
        [{ desc: AppendResponseSchema, value: { $typeName: "ccx.v1.AppendResponse" as const, size: res.size } }],
      );
    },
  };
}