import type { Command } from "commander";

import {
  claudeHome,
  createRepodir,
  loadConfig,
  localOrigin,
  localTranscripts,
  NoTranscriptStore,
  parseRepoSpec,
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
  // 保存先が S3 を話すかを 1 往復で見る。object API を持たない古い center (#122 より前) は
  // `HEAD /<bucket>` に 404 を返し、そのまま進むと S3 クライアントの "key does not exist" に化ける
  const probe = await fetch(`${cfg.transcript.endpoint.replace(/\/$/, "")}/${cfg.transcript.bucket}`, { method: "HEAD" }).catch(
    (e: unknown) => {
      throw new Error(`transcript store ${cfg.transcript!.endpoint} did not answer: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
  if (probe.status === 404) {
    throw new Error(
      `${cfg.transcript.endpoint} answers but has no S3 object API (bucket ${cfg.transcript.bucket} → 404). ` +
        "A ccx-center older than #122? Update it, or point CCX_TRANSCRIPT_ENDPOINT at an S3-compatible service.",
    );
  }
  // machine は ccxd と同じ規則で決める。center の event と同じ名前で並ぶように
  return new TranscriptClient(cfg.transcript, localOrigin(cfg.machine));
}

const human = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}K` : `${(bytes / 1024 / 1024).toFixed(1)}M`);

/** 引数の id か、--ended なら動いていない全部。どちらも無ければ何を指すか分からないので止まる */
async function select(ids: string[], ended: boolean): Promise<{ picked: LocalTranscript[]; running: Set<string> }> {
  const [all, running] = await Promise.all([localTranscripts(), runningSessionIds()]);
  if (ids.length) {
    const byId = new Map(all.map((t) => [t.sessionId, t]));
    const picked: LocalTranscript[] = [];
    for (const id of ids) {
      const exact = byId.get(id);
      const hits = exact ? [exact] : all.filter((x) => x.sessionId.startsWith(id));
      if (hits.length === 0) throw new Error(`no local transcript for session ${id}`);
      // 曖昧な prefix で prune すると意図しない session を消す。rd rm と同じく止まる
      if (hits.length > 1) throw new Error(`${id} matches ${hits.length} sessions: ${hits.map((h) => h.sessionId).join(", ")}`);
      picked.push(hits[0]!);
    }
    return { picked, running };
  }
  if (ended) return { picked: all.filter((t) => !running.has(t.sessionId)), running };
  throw new Error("give session ids, or --ended for every session that is not running");
}

export function registerTranscript(program: Command, VERSION: string): void {
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
        if (!o.json) console.log(`${r.status.padEnd(9)} ${t.sessionId}  ${human(r.meta.size)}  ${r.meta.cwd}`);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      if (!o.json && picked.length === 0) console.error("nothing to push");
    });

  transcript
    .command("pull")
    .description("Fetch a transcript from the store so that `claude --resume <id>` works here")
    .argument("<session-id>", "full id, or the unique prefix that `ls` prints")
    .option("--force", "replace a local transcript with the same id but different content (the local file is kept as .replaced-<time>)")
    .option("--no-repodir", "only install the transcript; do not create a repodir for the session's repo")
    .option("--json", "print as JSON")
    .action(async (idOrPrefix: string, o) => {
      const cfg = await loadConfig();
      const c = await client();
      const id = await c.resolve(idOrPrefix);
      if (!id) throw new Error(`no session in the store matches ${idOrPrefix}`);
      const r = await c.pull(id, claudeHome(), Boolean(o.force));

      // 会話だけでは作業できない。session.json の repo から、default branch の最新で
      // 作業場所を作る (元の branch には戻さない: 未 push の続きは transcript に無い)。
      // Claude Code は session を id で引くので、JSONL の置き場所と cwd は一致しなくてよい (#110)
      let repodir: string | undefined;
      if (o.repodir !== false && r.meta.repo) {
        const spec = parseRepoSpec(r.meta.repo, { defaultHost: cfg.defaultHost, defaultOwner: cfg.defaultOwner });
        const made = await createRepodir(cfg, spec, { initialTask: `resume session ${id}`, refresh: true }, VERSION);
        repodir = made.path;
      }

      if (o.json) {
        console.log(JSON.stringify({ ...r, repodir }, null, 2));
        return;
      }
      console.log(`${r.status}  ${r.path}`);
      if (r.replaced) console.log(`the previous local file was kept as ${r.replaced}`);
      if (repodir) {
        console.log(`repodir       ${repodir}  (${r.meta.repo}, default branch, fresh)`);
        console.log(`resume with:  cd ${repodir} && claude --resume ${id}`);
      } else {
        console.log(`resume with:  claude --resume ${id}${r.meta.repo ? "" : "   (no repo recorded for this session; run it where you like)"}`);
      }
      console.log(`pushed from ${r.meta.machine} (${r.meta.user}) at ${r.meta.pushedAt}; cwd was ${r.meta.cwd}${r.meta.gitBranch ? ` on ${r.meta.gitBranch}` : ""}`);
    });

  transcript
    .command("ls")
    .description("List sessions in the store, newest push first")
    .option("-m, --machine <name>", "only sessions pushed from this machine")
    .option("--json", "print as JSON")
    .action(async (o) => {
      const c = await client();
      const metas = await c.list(o.machine);
      // 「最後に誰が pull したか」は履歴から。JSON にも同じ形で載せる
      const withPull = await Promise.all(
        metas.map(async (m) => {
          const h = await c.history(m);
          return { ...m, lastPull: [...h].reverse().find((e) => e.op === "pull") ?? null };
        }),
      );
      if (o.json) {
        console.log(JSON.stringify(withPull, null, 2));
        return;
      }
      if (withPull.length === 0) {
        console.error(o.machine ? `nothing in the store from ${o.machine}` : "the store is empty");
        return;
      }
      const rows = withPull.map((m) => [
        shortId(m.sessionId),
        m.machine,
        m.user,
        human(m.size),
        `${humanSince(Date.parse(m.pushedAt))} ago`,
        m.lastPull ? `pulled on ${m.lastPull.machine} ${humanSince(Date.parse(m.lastPull.at))} ago` : "",
        m.cwd,
      ]);
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
        if (!o.json) console.log(`${r.status.padEnd(7)} ${t.sessionId}  ${r.reason ?? t.path}`);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      // 1 件でも断ったら非 0。「全部消えた」と読まれないように
      if (refused) process.exitCode = 1;
    });
}
