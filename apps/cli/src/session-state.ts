import type { Command } from "commander";

import {
  claudeHome,
  flagsOf,
  isFlag,
  FLAGS,
  loadConfig,
  localOrigin,
  localTranscripts,
  markedSessionIds,
  readDeclared,
  resolveSessionId,
  runningSessionIds,
  TranscriptClient,
  writeDeclared,
  type Lifecycle,
  type DeclaredState,
} from "@ccx/core";

import { table } from "./format.ts";

/**
 * `ccx session mark / label / task / status` — 宣言された状態をローカルに書き、読む (#127)。
 *
 * center も保存先も要らない (docs/design/scope.md の invariant)。保存先に運ぶのは
 * `ccx tr push` で、ここは手元の印だけを扱う。id を省くと自分の session
 * (`CLAUDE_CODE_SESSION_ID`。Claude Code が hook / Bash に渡す)。
 */

async function knownIds(home: string): Promise<string[]> {
  const [ts, marked] = await Promise.all([localTranscripts(home), markedSessionIds(home)]);
  return [...ts.map((t) => t.sessionId), ...marked];
}

async function target(idOrPrefix: string | undefined, home: string): Promise<string> {
  if (idOrPrefix) return resolveSessionId(idOrPrefix, await knownIds(home));
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
 * 無く保存先にある。保存先が無いか答えなければ unknown (「無い」とは言わない)
 */
export async function lifecycleOf(
  sessionId: string,
  home: string,
  running: Set<string>,
  hasTranscript: boolean,
  store: TranscriptClient | null,
): Promise<Lifecycle> {
  if (running.has(sessionId)) return "running";
  if (hasTranscript) return "ended";
  if (!store) return "unknown";
  try {
    return (await store.find(sessionId)) ? "archived" : "unknown";
  } catch {
    return "unknown";
  }
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
      const id = await target(idOrPrefix, home);
      const [running, ts, s, store] = await Promise.all([runningSessionIds(home), localTranscripts(home), readDeclared(id, home), storeOrNull()]);
      const lifecycle = await lifecycleOf(id, home, running, ts.some((t) => t.sessionId === id), store);
      if (o.json) console.log(JSON.stringify({ sessionId: id, lifecycle, flags: flagsOf(s), ...s }, null, 2));
      else for (const line of show(id, lifecycle, s)) console.log(line);
    });
}
