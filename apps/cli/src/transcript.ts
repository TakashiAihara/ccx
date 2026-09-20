import type { Command } from "commander";

import {
  claudeHome,
  createRepodir,
  flagsOf,
  loadConfig,
  localOrigin,
  localTranscripts,
  NoTranscriptStore,
  parseRepoSpec,
  readDeclared,
  runningSessionIds,
  TranscriptClient,
  type LocalTranscript,
} from "@ccx/core";

import { humanSince, parseLimit, shortId, table } from "./format.ts";

/**
 * `ccx transcript` — session の transcript を保存先に置き、別マシンで取り出す (#121)。
 *
 * 対象は session id か選択子で受ける。`--ended` は観測 (動いていない全部)、`--done` は
 * 宣言 (`ccx session mark done` が立っている全部)。両方付ければ AND (#127)。
 * 宣言された状態 (state.json) は push が運び、pull が手元の印に写す。
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
  // machine は ccx-agent と同じ規則で決める。center の event と同じ名前で並ぶように
  return new TranscriptClient(cfg.transcript, localOrigin(cfg.machine));
}

const human = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}K` : `${(bytes / 1024 / 1024).toFixed(1)}M`);

export type Selector = { ended?: boolean; done?: boolean };

/**
 * 引数の id か、選択子に当たる全部。どちらも無ければ何を指すか分からないので止まる。
 * prune は選択子で選んだ running を先に外す (「done だが動いている」を refused で
 * 数えると、退役していない session が毎回 exit 1 を作る)
 */
export async function select(
  ids: string[],
  sel: Selector,
  opts: { home?: string; excludeRunning?: boolean } = {},
): Promise<{ picked: LocalTranscript[]; running: Set<string> }> {
  const home = opts.home ?? claudeHome();
  const [all, running] = await Promise.all([localTranscripts(home), runningSessionIds(home)]);
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
  if (!sel.ended && !sel.done) throw new Error("give session ids, or a selector: --ended (not running) / --done (marked done)");
  const picked: LocalTranscript[] = [];
  for (const t of all) {
    if ((sel.ended || opts.excludeRunning) && running.has(t.sessionId)) continue;
    if (sel.done && !(await readDeclared(t.sessionId, home)).done) continue;
    picked.push(t);
  }
  return { picked, running };
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
    .option("--done", "every local session marked done (ccx session mark done)")
    .option("--json", "print as JSON")
    .action(async (ids: string[], o) => {
      const c = await client();
      const { picked } = await select(ids, { ended: Boolean(o.ended), done: Boolean(o.done) });
      const results = [];
      for (const t of picked) {
        const r = await c.push(t);
        results.push({ sessionId: t.sessionId, ...r });
        const flags = flagsOf(r.state).join(",");
        if (!o.json) console.log(`${r.status.padEnd(9)} ${t.sessionId}  ${human(r.meta.size)}  ${flags ? `[${flags}]  ` : ""}${r.meta.cwd}`);
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
      if (r.state) {
        const parts = [flagsOf(r.state).join(","), r.state.label && `label: ${r.state.label}`, r.state.task && `task: ${r.state.task}`].filter(Boolean);
        if (parts.length) console.log(`state         ${parts.join("  ")}${r.status === "pulled" ? "" : "  (not applied: the transcript was already here)"}`);
      }
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
          const [h, state] = await Promise.all([c.history(m), c.readRemoteDeclared(m.sessionId, m)]);
          return { ...m, lastPull: [...h].reverse().find((e) => e.op === "pull") ?? null, state };
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
        m.state ? flagsOf(m.state).join(",") : "",
        human(m.size),
        `${humanSince(Date.parse(m.pushedAt))} ago`,
        m.lastPull ? `pulled on ${m.lastPull.machine} ${humanSince(Date.parse(m.lastPull.at))} ago` : "",
        m.cwd,
        m.state?.label ?? "",
      ]);
      for (const line of table(rows)) console.log(line);
    });

  transcript
    .command("search")
    .description("Search every transcript in the store with DuckDB (embedded)")
    .argument("[text]", "case-insensitive substring of any message")
    .option("--sql <query>", "run this SQL instead; the views are `transcripts` and `history`")
    .option("-s, --session <id>", "only this session (full id or prefix)")
    .option("-n, --limit <count>", "at most this many rows (default 50)", parseLimit)
    .option("--json", "print rows as JSON")
    .action(async (text: string | undefined, o) => {
      if (!text && !o.sql) throw new Error("give text to search for, or --sql");
      if (text && o.sql) throw new Error("give either text or --sql, not both");
      if (o.sql && (o.limit !== undefined || o.session)) throw new Error("-n / -s do not apply to --sql; put them in the query");
      const cfg = await loadConfig();
      if (!cfg.transcript) throw new NoTranscriptStore();
      const { openDuckDB } = await import("./duckdb.ts");
      const c = await openDuckDB(cfg.transcript, { session: o.session, withHistory: Boolean(o.sql) });
      const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
      // 生の行 (`lines`) を探す。構造化した `transcripts` を to_json すると無いキーが null で
      // 全行に現れ、"null" がすべてに当たる。位置も同じ文字列で取るので snippet は必ず当たりを含む
      const sql =
        o.sql ??
        `SELECT session_id, machine, "user", json->>'type' AS type, json->>'timestamp' AS timestamp,
                substr(json::VARCHAR, greatest(1, position(lower(${q(text!)}) IN lower(json::VARCHAR)) - 60), 200) AS snippet
         FROM lines
         WHERE contains(lower(json::VARCHAR), lower(${q(text!)}))
         ORDER BY timestamp DESC
         LIMIT ${o.limit ?? 50}`;
      const r = await c.runAndReadAll(sql);
      const cols = r.columnNames();
      // DuckDB の JSON 変換は BIGINT を文字列で出す ("7")。そのまま渡す
      const rows = r.getRowObjectsJson();
      if (o.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.error("no match");
        return;
      }
      const out = rows.map((row) =>
        cols.map((k) => {
          const v = row[k];
          const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
          // 短縮は既定の検索結果だけ。--sql の列はそのまま
          if (!o.sql && k === "session_id") return shortId(String(s));
          const one = s.replaceAll("\n", " ");
          return one.length > 200 ? `${one.slice(0, 199)}…` : one;
        }),
      );
      for (const line of table([cols, ...out])) console.log(line);
    });

  transcript
    .command("prune")
    .description("Delete local transcripts whose copy in the store matches byte for byte")
    .argument("[session-id...]", "session ids (a unique prefix is enough)")
    .option("--ended", "every local session that is not running")
    .option("--done", "every local session marked done and not running")
    .option("--json", "print as JSON")
    .action(async (ids: string[], o) => {
      const c = await client();
      const { picked, running } = await select(ids, { ended: Boolean(o.ended), done: Boolean(o.done) }, { excludeRunning: true });
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
