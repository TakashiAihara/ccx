import type { Command } from "commander";

import {
  claudeHome,
  flagsOf,
  isFlag,
  FLAGS,
  loadConfig,
  localOrigin,
  localTranscripts,
  isEmptyDeclared,
  markedSessionIds,
  NoLocalSession,
  readDeclared,
  resolveSessionId,
  runningSessionIds,
  TranscriptClient,
  writeDeclared,
  type DeclaredState,
  type Lifecycle,
  type Origin,
} from "@ccx/core";

import { table } from "./format.ts";

/**
 * `ccx session mark / label / task / status` — 宣言された状態をローカルに書き、読む (#127)。
 *
 * 書く側 (mark / label / task) は center も保存先も要らない (docs/design/scope.md の
 * invariant)。読む側 (status) は手元を先に見て、手元に無い session (archived) だけ
 * 保存先の state.json を読む。保存先が無ければ unknown と言う。id を省くと自分の
 * session (`CLAUDE_CODE_SESSION_ID`。Claude Code が hook / Bash に渡す)。
 */

async function knownIds(home: string): Promise<string[]> {
  const [ts, marked] = await Promise.all([localTranscripts(home), markedSessionIds(home)]);
  return [...ts.map((t) => t.sessionId), ...marked];
}

/** 手元 (transcript と印) で解けなければ、保存先の一覧 (archived な session) でも試す */
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
  return own;
}

/** 保存先が設定されていれば client、無ければ null。無いのはエラーではない (見えないだけ) */
async function storeOrNull(): Promise<TranscriptClient | null> {
  const cfg = await loadConfig();
  return cfg.transcript ? new TranscriptClient(cfg.transcript, localOrigin(cfg.machine)) : null;
}

/**
 * 観測される状態。running は pid、ended は手元に transcript がある、archived は手元に
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
    return there ? "archived" : "unknown";
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
 * 表示する宣言状態。手元の印があればそれ、無ければ (archived なら) 保存先の state.json。
 * 手元の印は push で保存先に写るので、両方あるときは手元が新しい
 */
export async function declaredFor(
  sessionId: string,
  home: string,
  lifecycle: Lifecycle,
  store: TranscriptClient | null,
  origin?: Origin,
): Promise<DeclaredState> {
  const local = await readDeclared(sessionId, home);
  if (!isEmptyDeclared(local) || lifecycle !== "archived" || !store) return local;
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
    ["task", s.task || "-"],
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
      if (o.json) console.log(JSON.stringify({ sessionId: id, ...s }, null, 2));
      else console.log(`${flag} ${o.off ? "off" : "on"}  ${id}`);
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
      });
  }

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
