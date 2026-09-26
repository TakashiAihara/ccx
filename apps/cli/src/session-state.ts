import type { Command } from "commander";

import {
  claudeHome,
  flagsOf,
  isFlag,
  isMetaKey,
  META_KEY_RULE,
  FLAGS,
  loadConfig,
  localOrigin,
  localTranscripts,
  holdsDeclared,
  markedSessionIds,
  NoLocalSession,
  readDeclared,
  resolveSessionId,
  runningSessionIds,
  TranscriptClient,
  UUID,
  writeDeclared,
  type DeclaredState,
  type Lifecycle,
  type Origin,
} from "@ccx/core";

import { createClient } from "@connectrpc/connect";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { randomUUID } from "node:crypto";

import { IngestService, Producer } from "@ccx/proto/ccx/v1/ingest_pb.ts";

import { centerTransport, type Hub } from "./fleet.ts";

import { table } from "./format.ts";

/**
 * `ccx session mark / label / task / heartbeat / meta / status` — 宣言された状態をローカルに
 * 書き、読む (#127、metadata は #165)。
 *
 * 書く側 (mark / label / task / heartbeat / meta) は center も保存先も要らない (docs/design/scope.md の
 * invariant)。読む側 (status) は手元を先に見て、手元に無い session (remote) だけ
 * 保存先の state.json を読む。保存先が無ければ unknown と言う。id を省くと自分の
 * session (`CLAUDE_CODE_SESSION_ID`。Claude Code が hook / Bash に渡す)。
 */

async function knownIds(home: string): Promise<string[]> {
  const [ts, marked] = await Promise.all([localTranscripts(home), markedSessionIds(home)]);
  return [...ts.map((t) => t.sessionId), ...marked];
}

/** 手元 (transcript と印) で解けなければ、保存先の一覧 (remote な session) でも試す */
async function target(idOrPrefix: string | undefined, home: string, store: TranscriptClient | null = null): Promise<string> {
  if (idOrPrefix) {
    try {
      return resolveSessionId(idOrPrefix, await knownIds(home));
    } catch (e) {
      if (!(e instanceof NoLocalSession) || !store) throw e;
      const id = await store.resolve(idOrPrefix.toLowerCase()).catch(() => null);
      if (!id) throw e;
      return id;
    }
  }
  const own = process.env.CLAUDE_CODE_SESSION_ID;
  if (!own) throw new Error("give a session id, or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID)");
  // 引数と同じ規則で通す (小文字化 + UUID 検証)。UUID でない値をパスに使わない
  if (!UUID.test(own)) throw new Error(`CLAUDE_CODE_SESSION_ID is not a session id: ${own}`);
  return own.toLowerCase();
}

/**
 * 設定を読む。読めなければ stderr に 1 行出して null — 手元の宣言を読み書きするだけの
 * 操作 (mark / label / task / status) を、関係の無い設定 (clone の protocol 等) の誤りで
 * 止めない
 */
async function configOrNull(): Promise<Awaited<ReturnType<typeof loadConfig>> | null> {
  try {
    return await loadConfig();
  } catch (e) {
    console.error(`(ccx config could not be read: ${e instanceof Error ? e.message : String(e)}; center and store are skipped)`);
    return null;
  }
}

/** 保存先が設定されていれば client、無ければ null。無いのはエラーではない (見えないだけ) */
async function storeOrNull(): Promise<TranscriptClient | null> {
  const cfg = await configOrNull();
  return cfg?.transcript ? new TranscriptClient(cfg.transcript, localOrigin(cfg.machine)) : null;
}

/** 手元に書いた後で center に写す。設定が読めなければ写さない (書き込みは済んでいる) */
async function reportAfterWrite(sessionId: string, state: DeclaredState): Promise<void> {
  const cfg = await configOrNull();
  if (cfg) await reportState(cfg.hub, cfg.machine, sessionId, state);
}

/**
 * 書いた宣言状態を center にも写す (ingest.proto の PRODUCER_CCX_SESSION_STATE)。
 * center が無ければ何もしない、届かなければ stderr に 1 行出して終わる — 真実源は
 * 手元のファイルで、center は index。次の mark が送り直す。exit code は変えない
 */
const REPORT_TIMEOUT_MS = 3000;

const withoutHistory = ({ labelHistory: _, ...rest }: DeclaredState) => rest;

export async function reportState(hub: Hub | undefined, machine: string | undefined, sessionId: string, state: DeclaredState): Promise<void> {
  if (!hub) return;
  const origin = localOrigin(machine);
  const client = createClient(IngestService, centerTransport(hub));
  try {
    await client.ingest(
      {
        events: [
          {
            origin: { machine: origin.machine, user: origin.user },
            eventId: randomUUID(),
            // seq は spool の rowid のためのもの。ccx は spool を持たないので 0。順序は payload の rev
            seq: 0n,
            receivedAt: timestampFromMs(Date.now()),
            producer: Producer.CCX_SESSION_STATE,
            // rev: 送る直前の時刻。同じ session の報告どうしを center が並べるのに使う (同じ machine の
            // 時計なので比べられる)。先に書いて遅れて届いた古い写しが、後の写しに勝たないように
            // label の履歴は送らない: center は読まず (fleet.proto に欄が無い)、毎回全件を送ると 1 session で
            // 履歴の長さの 2 乗で events が太る。検索は保存先の state.json を読む (#169)
            payload: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, state: withoutHistory(state), rev: Date.now() })),
          },
        ],
      },
      // 繋がった後に黙る center で mark を止めない。期限切れは「受け取ったと言われなかった」で
      // あって「届かなかった」ではない (center が書いた後に返事だけ遅れたこともありうる)
      { timeoutMs: REPORT_TIMEOUT_MS },
    );
  } catch (e) {
    console.error(`(center ${hub.url} did not confirm the state: ${e instanceof Error ? e.message : String(e)}; it may or may not have been recorded there — it is recorded locally, and the next mark sends it again)`);
  }
}

/**
 * 観測される状態。running は pid、ended は手元に transcript がある、remote は手元に
 * 無く保存先にある。保存先が無いか答えなければ unknown (「無い」とは言わない)。
 * origin を渡せばその下だけを 1 GET で見る (`session ls` の行ごと用)。渡さなければ
 * 全 machine を探す (`find`。1 件を見る `status` 用)
 */
export async function lifecycleOf(
  sessionId: string,
  running: Set<string>,
  hasTranscript: boolean,
  store: TranscriptClient | null,
  origin?: Origin,
): Promise<Lifecycle> {
  if (running.has(sessionId)) return "running";
  if (hasTranscript) return "ended";
  if (!store) return "unknown";
  try {
    const there = origin ? await store.inStore(sessionId, origin) : (await store.find(sessionId)) !== null;
    return there ? "remote" : "unknown";
  } catch (e) {
    // 「保存先に無い」と「保存先が答えない」を同じ unknown にしない: 後者は stderr に出す
    warnStore(store, e);
    return "unknown";
  }
}

let warned = false;
function warnStore(store: TranscriptClient, e: unknown): void {
  if (warned) return;
  warned = true;
  console.error(`(transcript store ${store.store.endpoint} did not answer: ${e instanceof Error ? e.message : String(e)}; lifecycle and flags from it are unknown)`);
}

/**
 * 表示する宣言状態。この machine が宣言を持っていればそれ (全部外した状態を含む)、持って
 * いなければ (remote なら) 保存先の state.json。手元が勝つのは方針であって、手元が新しい
 * 保証ではない — 別の machine が後から保存先を書き換えていることはある
 */
export async function declaredFor(
  sessionId: string,
  home: string,
  lifecycle: Lifecycle,
  store: TranscriptClient | null,
  origin?: Origin,
): Promise<DeclaredState> {
  const local = await readDeclared(sessionId, home);
  if ((await holdsDeclared(sessionId, home)) || lifecycle !== "remote" || !store) return local;
  const remote = await (origin
    ? store.readRemoteDeclared(sessionId, origin)
    : store.find(sessionId).then((m) => (m ? store.readRemoteDeclared(sessionId, m) : null))
  ).catch((e: unknown) => {
    warnStore(store, e);
    return null;
  });
  return remote ?? local;
}

const show = (id: string, lifecycle: Lifecycle, s: DeclaredState) =>
  table([
    ["session", id],
    ["lifecycle", lifecycle],
    ["flags", flagsOf(s).join(",") || "-"],
    ["label", s.label || "-"],
    // 中身 (いつ何に変えたか) は --json と `ccx tr search`
    ["label history", s.labelHistory.length ? `${s.labelHistory.length} entries` : "-"],
    ["task", s.task || "-"],
    ["heartbeat", s.heartbeat || "default"],
    // 値に区切り (, =) や改行があれば JSON の文字列で出す。1 行 1 項目の表を崩さない
    ["metadata", Object.entries(s.metadata).map(([k, v]) => (!v ? k : /[,=\s"]/.test(v) ? `${k}=${JSON.stringify(v)}` : `${k}=${v}`)).join(",") || "-"],
  ]);

export function registerSessionState(session: Command): void {
  session
    .command("mark")
    .description(`Declare a flag on a session: ${FLAGS.join(" | ")} (--off to clear)`)
    .argument("<flag>", FLAGS.join(" | "))
    .argument("[session-id]", "full id or unique prefix (default: this session)")
    .option("--off", "clear the flag instead of setting it")
    .option("--json", "print the resulting state as JSON")
    .action(async (flag: string, idOrPrefix: string | undefined, o) => {
      if (!isFlag(flag)) throw new Error(`unknown flag ${flag}; one of ${FLAGS.join(", ")}`);
      const home = claudeHome();
      const id = await target(idOrPrefix, home);
      const s = await writeDeclared(id, { [flag]: !o.off }, home);
      // 書けた事実を先に出す。center が遅くても、書き込みが済んだことは隠れない
      if (o.json) console.log(JSON.stringify({ sessionId: id, ...s }, null, 2));
      else console.log(`${flag} ${o.off ? "off" : "on"}  ${id}`);
      await reportAfterWrite(id, s);
    });

  for (const key of ["label", "task"] as const) {
    session
      .command(key)
      .description(key === "label" ? "Name a session (free text; an empty string clears it)" : "Point a session at the task it is on, e.g. kaneo ccx#1 or owner/repo#123 (an empty string clears it)")
      .argument(`<${key}>`, key === "label" ? "the label" : "one external reference")
      .argument("[session-id]", "full id or unique prefix (default: this session)")
      .option("--json", "print the resulting state as JSON")
      .action(async (value: string, idOrPrefix: string | undefined, o) => {
        const home = claudeHome();
        const id = await target(idOrPrefix, home);
        const s = await writeDeclared(id, { [key]: value.trim() }, home);
        if (o.json) console.log(JSON.stringify({ sessionId: id, ...s }, null, 2));
        else console.log(`${key} ${s[key] ? `= ${s[key]}` : "cleared"}  ${id}`);
        await reportAfterWrite(id, s);
      });
  }

  session
    .command("heartbeat")
    .description("Keep this session's prompt cache warm or not, over ccx-agent's default (default clears the override)")
    .argument("<setting>", "on | off | default")
    .argument("[session-id]", "full id or unique prefix (default: this session)")
    .option("--json", "print the resulting state as JSON")
    .action(async (setting: string, idOrPrefix: string | undefined, o) => {
      if (!["on", "off", "default"].includes(setting)) throw new Error(`unknown setting ${setting}; one of on, off, default`);
      const home = claudeHome();
      const id = await target(idOrPrefix, home);
      const s = await writeDeclared(id, { heartbeat: setting === "default" ? "" : (setting as "on" | "off") }, home);
      if (o.json) console.log(JSON.stringify({ sessionId: id, ...s }, null, 2));
      else console.log(`heartbeat ${s.heartbeat || "default"}  ${id}`);
      await reportAfterWrite(id, s);
    });

  const meta = session
    .command("meta")
    .description("User-defined key/value on a session. ccx gives the keys no meaning; they live in ~/.claude/sessions/<id>/meta/<key>");

  meta
    .command("set")
    .description("Set a key, with or without a value (key alone = present with no value)")
    .argument("<key[=value]>", "e.g. done, or owner=alice")
    .argument("[session-id]", "full id or unique prefix (default: this session)")
    .option("--json", "print the resulting state as JSON")
    .action(async (kv: string, idOrPrefix: string | undefined, o) => {
      const eq = kv.indexOf("=");
      const key = eq < 0 ? kv : kv.slice(0, eq);
      const value = eq < 0 ? "" : kv.slice(eq + 1);
      if (!isMetaKey(key)) throw new Error(`invalid key ${JSON.stringify(key)}: ${META_KEY_RULE}`);
      const home = claudeHome();
      const id = await target(idOrPrefix, home);
      const s = await writeDeclared(id, { metadata: { [key]: value } }, home);
      if (o.json) console.log(JSON.stringify({ sessionId: id, ...s }, null, 2));
      else console.log(`${key}${value ? ` = ${value}` : " set"}  ${id}`);
      await reportAfterWrite(id, s);
    });

  meta
    .command("unset")
    .description("Remove a key")
    .argument("<key>")
    .argument("[session-id]", "full id or unique prefix (default: this session)")
    .option("--json", "print the resulting state as JSON")
    .action(async (key: string, idOrPrefix: string | undefined, o) => {
      if (!isMetaKey(key)) throw new Error(`invalid key ${JSON.stringify(key)}: ${META_KEY_RULE}`);
      const home = claudeHome();
      const id = await target(idOrPrefix, home);
      const s = await writeDeclared(id, { metadata: { [key]: null } }, home);
      if (o.json) console.log(JSON.stringify({ sessionId: id, ...s }, null, 2));
      else console.log(`${key} unset  ${id}`);
      await reportAfterWrite(id, s);
    });

  session
    .command("status")
    .description("Lifecycle (observed) and declared state of one session, from local files and the store")
    .argument("[session-id]", "full id or unique prefix (default: this session)")
    .option("--json", "print as JSON")
    .action(async (idOrPrefix: string | undefined, o) => {
      const home = claudeHome();
      const store = await storeOrNull();
      const id = await target(idOrPrefix, home, store);
      const [running, ts] = await Promise.all([runningSessionIds(home), localTranscripts(home)]);
      const lifecycle = await lifecycleOf(id, running, ts.some((t) => t.sessionId === id), store);
      const s = await declaredFor(id, home, lifecycle, store);
      if (o.json) console.log(JSON.stringify({ sessionId: id, lifecycle, ...s }, null, 2));
      else for (const line of show(id, lifecycle, s)) console.log(line);
    });
}
