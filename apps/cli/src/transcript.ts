import type { Command } from "commander";

import {
  claudeHome,
  loadConfig,
  localTranscripts,
  NoTranscriptStore,
  runningSessionIds,
  TranscriptClient,
  type LocalTranscript,
} from "@ccx/core";

import { humanSince, shortId, table } from "./format.ts";

/**
 * `ccx transcript` — session の transcript を保存先に置き、別マシンで取り出す (#121)。
 *
 * どの session が「終わった」かは ccx は決めない。分かるのは「動いていない」だけで、
 * 終わったと印を付けるのは利用者の運用 (docs/design/scope.md: mechanism / methodology)。
 * だから対象は session id で受け、`--ended` は「動いていない全部」を指す。
 */

async function client() {
  const cfg = await loadConfig();
  if (!cfg.transcript) throw new NoTranscriptStore();
  return new TranscriptClient(cfg.transcript);
}

/** 引数の id か、--ended なら動いていない全部。どちらも無ければ何を指すか分からないので止まる */
async function select(ids: string[], ended: boolean): Promise<{ picked: LocalTranscript[]; running: Set<string> }> {
  const [all, running] = await Promise.all([localTranscripts(), runningSessionIds()]);
  if (ids.length) {
    const byId = new Map(all.map((t) => [t.sessionId, t]));
    const picked: LocalTranscript[] = [];
    for (const id of ids) {
      const t = byId.get(id) ?? all.find((x) => x.sessionId.startsWith(id));
      if (!t) throw new Error(`no local transcript for session ${id}`);
      picked.push(t);
    }
    return { picked, running };
  }
  if (ended) return { picked: all.filter((t) => !running.has(t.sessionId)), running };
  throw new Error("give session ids, or --ended for every session that is not running");
}

export function registerTranscript(program: Command): void {
  const transcript = program
    .command("transcript")
    .alias("tr")
    .description("Store session transcripts in an S3-compatible store and bring them back anywhere");

  transcript
    .command("push")
    .description("Copy local transcripts to the store (unchanged ones are skipped)")
    .argument("[session-id...]", "session ids (a unique prefix is enough)")
    .option("--ended", "every local session that is not running")
    .option("--json", "print as JSON")
    .action(async (ids: string[], o) => {
      const c = await client();
      const { picked } = await select(ids, Boolean(o.ended));
      const results = [];
      for (const t of picked) {
        const r = await c.push(t);
        results.push({ sessionId: t.sessionId, ...r });
        if (!o.json) console.log(`${r.status.padEnd(9)} ${t.sessionId}  ${r.meta.cwd}`);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      if (!o.json && picked.length === 0) console.error("nothing to push");
    });

  transcript
    .command("pull")
    .description("Fetch a transcript from the store so that `claude --resume <id>` works here")
    .argument("<session-id>")
    .option("--force", "overwrite a local transcript with the same id but different content")
    .option("--json", "print as JSON")
    .action(async (id: string, o) => {
      const c = await client();
      const r = await c.pull(id, claudeHome(), Boolean(o.force));
      if (o.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(`${r.status}  ${r.path}`);
      console.log(`resume with:  claude --resume ${id}`);
      console.log(`pushed from ${r.meta.machine} (${r.meta.user}) at ${r.meta.pushedAt}; cwd was ${r.meta.cwd}`);
    });

  transcript
    .command("ls")
    .description("List sessions in the store, newest push first")
    .option("-m, --machine <name>", "only sessions pushed from this machine")
    .option("--json", "print as JSON")
    .action(async (o) => {
      const c = await client();
      let metas = await c.list();
      if (o.machine) metas = metas.filter((m) => m.machine === o.machine);
      if (o.json) {
        console.log(JSON.stringify(metas, null, 2));
        return;
      }
      if (metas.length === 0) {
        console.error("the store is empty");
        return;
      }
      const rows: string[][] = [];
      for (const m of metas) {
        const h = await c.history(m);
        const lastPull = [...h].reverse().find((e) => e.op === "pull");
        rows.push([
          shortId(m.sessionId),
          m.machine,
          m.user,
          `${(m.size / 1024 / 1024).toFixed(1)}M`,
          humanSince(Date.parse(m.pushedAt)),
          lastPull ? `pulled ${lastPull.machine} ${humanSince(Date.parse(lastPull.at))} ago` : "",
          m.cwd,
        ]);
      }
      for (const line of table(rows)) console.log(line);
    });

  transcript
    .command("prune")
    .description("Delete local transcripts whose copy in the store matches byte for byte")
    .argument("[session-id...]", "session ids (a unique prefix is enough)")
    .option("--ended", "every local session that is not running")
    .option("--json", "print as JSON")
    .action(async (ids: string[], o) => {
      const c = await client();
      const { picked, running } = await select(ids, Boolean(o.ended));
      const results = [];
      let refused = 0;
      for (const t of picked) {
        const r = await c.prune(t, running);
        results.push({ sessionId: t.sessionId, ...r });
        if (r.status === "refused") refused += 1;
        if (!o.json) console.log(`${r.status.padEnd(8)} ${t.sessionId}  ${r.reason ?? t.path}`);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      // 1 件でも断ったら非 0。「全部消えた」と読まれないように
      if (refused) process.exitCode = 1;
    });
}
