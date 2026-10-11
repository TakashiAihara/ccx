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
import { reportState } from "./session-state.ts";

/**
 * `ccx transcript` — session の transcript を保存先に置き、別マシンで取り出す (#121)。
 *
 * 対象は session id か選択子で受ける。`--ended` は観測 (動いていない全部)、`--archived`
 * は宣言 (`ccx session mark archived` が立っている全部)。両方付ければ AND (#127)。
 * 宣言された状態 (state.json) は push が運び、pull が手元の印に写す。
 */

async function client() {
  const cfg = await loadConfig();
  if (!cfg.transcript) throw new NoTranscriptStore();
  // 保存先が S3 を話すかを 1 往復で見る。object API を持たない古い center (#122 より前) は
  // `HEAD /<bucket>` に 404 を返し、そのまま進むと S3 クライアントの "key does not exist" に化ける
  const headers: Record<string, string> = cfg.transcript.token ? { Authorization: `Bearer ${cfg.transcript.token}` } : {};
  const probe = await fetch(`${cfg.transcript.endpoint.replace(/\/$/, "")}/${cfg.transcript.bucket}`, { method: "HEAD", headers }).catch(
    (e: unknown) => {
      throw new Error(`transcript store ${cfg.transcript!.endpoint} did not answer: ${e instanceof Error ? e.message : String(e)}`);
    },
  );
  if (probe.status === 401) {
    throw new Error(
      `${cfg.transcript.endpoint} wants a token (401). Set CCX_HUB_TOKEN, or put it in ~/.config/ccx/hub-token, ` +
        "with the value of the center's CCX_CENTER_TOKEN.",
    );
  }
  if (probe.status === 404) {
    throw new Error(
      `${cfg.transcript.endpoint} answers but has no S3 object API (bucket ${cfg.transcript.bucket} → 404). ` +
        "A ccx-center older than #122? Update it.",
    );
  }
  // machine は ccx-agent と同じ規則で決める。center の event と同じ名前で並ぶように
  return new TranscriptClient(cfg.transcript, localOrigin(cfg.machine));
}


const human = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}K` : `${(bytes / 1024 / 1024).toFixed(1)}M`);

export type Selector = { ended?: boolean; archived?: boolean };

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
  if (!sel.ended && !sel.archived) throw new Error("give session ids, or a selector: --ended (not running) / --archived (marked archived)");
  const picked: LocalTranscript[] = [];
  for (const t of all) {
    if ((sel.ended || opts.excludeRunning) && running.has(t.sessionId)) continue;
    if (sel.archived) {
      // 読めない session は選ばない (archived か分からない)。他の session の選択は止めない
      const archived = await readDeclared(t.sessionId, home).then(
        (s) => s.archived,
        (e: unknown) => {
          console.error(`(${t.sessionId}: skipped, declared state could not be read: ${e instanceof Error ? e.message : String(e)})`);
          process.exitCode = 1;
          return false;
        },
      );
      if (!archived) continue;
    }
    picked.push(t);
  }
  return { picked, running };
}

export function registerTranscript(program: Command, VERSION: string): void {
  const transcript = program
    .command("transcript")
    .alias("tr")
    .description("Store session transcripts in ccx-center and bring them back anywhere");

  transcript
    .command("push")
    .description("Copy local transcripts to the store (unchanged ones are skipped)")
    .argument("[session-id...]", "session ids (a unique prefix is enough)")
    .option("--ended", "every local session that is not running")
    .option("--archived", "every local session marked archived (ccx session mark archived)")
    .option("--dry-run", "say what would be pushed, unchanged or refused, and write nothing")
    .option("--force", "push even when another machine pushed last and the local copy does not continue it, or is behind it (its copy stays, but pull stops picking it)")
    .option("--json", "print as JSON")
    .action(async (ids: string[], o) => {
      const c = await client();
      const { picked } = await select(ids, { ended: Boolean(o.ended), archived: Boolean(o.archived) });
      const results = [];
      for (const t of picked) {
        // 1 件の失敗 (保存先が答えない等) で残りを止めない
        let r: Awaited<ReturnType<typeof c.push>>;
        try {
          r = await c.push(t, claudeHome(), { force: Boolean(o.force), dryRun: Boolean(o.dryRun) });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          console.error(`(${t.sessionId}: not pushed: ${error})`);
          results.push({ sessionId: t.sessionId, status: "failed", error });
          process.exitCode = 1;
          continue;
        }
        results.push({ sessionId: t.sessionId, ...r, ...(o.dryRun ? { dryRun: true } : {}) });
        if (r.status === "refused") {
          console.error(`(${t.sessionId}: not pushed: ${r.reason}; --force makes this copy the one pull picks)`);
          process.exitCode = 1;
        }
        if (r.status === "behind") console.error(`(${t.sessionId}: nothing to push: ${r.reason})`);
        if (r.stateError) {
          console.error(`(${t.sessionId}: transcript ${r.status}, state.json not written: declared state could not be read: ${r.stateError})`);
          process.exitCode = 1;
        }
        const flags = r.state ? flagsOf(r.state).join(",") : "?";
        if (!o.json) console.log(`${r.status.padEnd(9)} ${t.sessionId}  ${human(r.meta.size)}  ${flags ? `[${flags}]  ` : ""}${r.meta.cwd}`);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      if (!o.json && picked.length === 0) console.error("nothing to push");
      if (o.dryRun) console.error("(dry run: nothing was written)");
    });

  transcript
    .command("pull")
    .description("Fetch transcripts from the store so that `claude --resume <id>` works here")
    .argument("<session-id...>", "full ids, or the unique prefixes that `ls` prints")
    .option("--force", "replace a local transcript with the same id but different content (the local file is kept as .replaced-<time>)")
    .option("--no-repodir", "only install the transcript; do not create a repodir for the session's repo")
    .option("--json", "print as JSON (an array, one entry per id, like push and prune)")
    .action(async (ids: string[], o) => {
      const cfg = await loadConfig();
      const c = await client();
      const done: Record<string, unknown>[] = [];
      // 1 件の失敗で残りを止めない。失敗した id は exit 1 で、戻せたものは戻したまま
      for (const idOrPrefix of ids) {
        try {
          done.push(await pullOne(c, cfg, VERSION, idOrPrefix, o));
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          console.error(`(${idOrPrefix}: not pulled: ${error})`);
          done.push({ sessionId: idOrPrefix, status: "failed", error });
          process.exitCode = 1;
        }
      }
      if (o.json) {
        console.log(JSON.stringify(done, null, 2));
        return;
      }
      if (ids.length > 1) {
        console.log("");
        const rows = done.map((r) => [String(r.sessionId), String(r.status), r.repodir ? String(r.repodir) : r.repodirError ? "(repodir failed)" : ""]);
        for (const line of table([["session", "status", "repodir"], ...rows])) console.log(line);
      }
    });

  transcript
    .command("ls")
    .description("List sessions in the store, newest push first. A session whose state.json cannot be read shows ? where its flags (archived, …) go, with stateError in --json, and the rest are listed")
    .option("-m, --machine <name>", "only sessions pushed from this machine")
    .option("-s, --session <id>", "only this session (full id or unique prefix), every machine's copy; exit 1 when it is not in the store, 2 when the store could not be read or the prefix is ambiguous (a state.json that is not valid JSON shows ?, not 2)")
    .option("--json", "print as JSON")
    .action(async (o) => {
      // --session では保存先が答えないのも「引けなかった」(2)。未設定 (3) は他のコマンドと同じ
      const c = await client().catch((e: unknown) => {
        if (o.session === undefined || e instanceof NoTranscriptStore) throw e;
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      });
      // 1 件を見るために全件を読ませない (#183)。無いことを exit 1 で返すので、`if ccx tr ls -s "$id"` で書ける
      let metas: Awaited<ReturnType<typeof c.list>>;
      if (o.session !== undefined) {
        // 「無い」(1) と「引けなかった」(2: 保存先が答えない / prefix が曖昧) を分ける。meta get と同じ
        try {
          // 空の指定は全件に当たる prefix になるので、何も指していないものとして断る
          if (String(o.session).trim() === "") throw new Error("--session needs an id or a prefix");
          const id = await c.resolve(String(o.session).toLowerCase());
          metas = id ? (await c.findAll(id)).filter((m) => !o.machine || m.machine === o.machine) : [];
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(2);
        }
        if (metas.length === 0) {
          console.error(`${o.session} is not in the store${o.machine ? ` from ${o.machine}` : ""}`);
          process.exitCode = 1;
          if (o.json) console.log("[]");
          return;
        }
      } else metas = await c.list(o.machine);
      // 「最後に誰が pull したか」は履歴から。JSON にも同じ形で載せる
      const withPull = await Promise.all(
        metas.map(async (m) => {
          // 読めない state.json 1 件で一覧を止めない (#229)。一覧は c.list の読めない meta と同じく理由を問わず
          // 1 行出して続ける。-s は壊れた JSON だけ: session は保存先に在る (1 ではない) が、保存先が答えないのは
          // session.json / 履歴と同じく 2
          let stateError: string | undefined;
          const [h, state] = await Promise.all([
            c.history(m),
            c.readRemoteDeclared(m.sessionId, m).catch((e: unknown) => {
              if (o.session !== undefined && !(e instanceof SyntaxError)) throw e;
              stateError = (e instanceof Error ? e.message : String(e)) || "unreadable";
              console.error(`(could not read the state of ${m.sessionId} from ${m.machine}: ${stateError})`);
              return null;
            }),
          ]);
          return { ...m, lastPull: [...h].reverse().find((e) => e.op === "pull") ?? null, state, ...(stateError ? { stateError } : {}) };
        }),
      ).catch((e: unknown) => {
        // --session では見つけた後に読めなかったのも 2 (1 は「無い」だけ)
        if (o.session === undefined) throw e;
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(2);
      });
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
        m.stateError ? "?" : m.state ? flagsOf(m.state).join(",") : "",
        human(m.size),
        `${humanSince(Date.parse(m.pushedAt))} ago`,
        m.lastPull ? `pulled on ${m.lastPull.machine} ${humanSince(Date.parse(m.lastPull.at))} ago` : "",
        m.cwd,
        // 見出しの無い表で、隣の label (自由文) と読み分けられるよう名前を付ける
        m.state?.role ? `role:${m.state.role}` : "",
        m.state?.label ?? "",
      ]);
      for (const line of table(rows)) console.log(line);
    });

  transcript
    .command("search")
    .description("Search every transcript in the store with DuckDB (embedded)")
    .argument("[text]", "case-insensitive substring of any message")
    .option("--sql <query>", "run this SQL instead; the views are `transcripts`, `lines` (raw records), `history` and `sessions` (label, label_history, role, metadata)")
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
      // 全行に現れ、"null" がすべてに当たる。位置も同じ文字列で取るので snippet は必ず当たりを含む。
      // session の宣言状態 (label / その履歴 / task / role / metadata) も同じ検索に入れる: 名前で session を探せるように (#169)。
      // その行は type = 'ccx.state' (Claude Code の record type と混ざらない名前)、時刻は ccx が最後に label を記録した
      // 時刻。state の行は先に出す: 履歴の無い session は時刻が NULL で末尾に回り、transcript の当たりが多いと LIMIT で
      // 消える。state は 1 session の 1 写しに 1 行で、名前で session を探すのがこの検索の目的なので、先頭を譲る
      const sql =
        o.sql ??
        `SELECT session_id, machine, "user", type, timestamp,
                substr(body, greatest(1, position(lower(${q(text!)}) IN lower(body)) - 60), 200) AS snippet
         FROM (
           SELECT session_id, machine, "user", json->>'type' AS type, json->>'timestamp' AS timestamp, json::VARCHAR AS body FROM lines
           UNION ALL
           -- 値だけを並べる: state.json をそのまま文字列にすると "label" / "archived" 等のキー名が全行に当たる。
           -- metadata は key も入れる: 値の無い key (done 等) は key そのものが中身
           SELECT session_id, machine, "user", 'ccx.state', label_recorded_at,
                  concat_ws(chr(10), label, task, role, metadata::VARCHAR, array_to_string(json_extract_string(json, '$.labelHistory[*].label'), chr(10)))
           FROM sessions
         )
         WHERE contains(lower(body), lower(${q(text!)}))
         ORDER BY type = 'ccx.state' DESC, timestamp DESC
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
    .command("stats")
    .description("Per day: how often a person typed to the AI, and how often they interrupted or refused it")
    .option("--tz <zone>", "IANA time zone that decides where a day starts (default: this machine's)")
    .option("--json", "print rows as JSON")
    .action(async (o) => {
      const cfg = await loadConfig();
      if (!cfg.transcript) throw new NoTranscriptStore();
      const { openDuckDB } = await import("./duckdb.ts");
      const { interactionSql } = await import("./stats.ts");
      const c = await openDuckDB(cfg.transcript);
      const r = await c.runAndReadAll(interactionSql(o.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
      const rows = r.getRowObjectsJson();
      if (o.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      const cols = r.columnNames();
      for (const line of table([cols, ...rows.map((row) => cols.map((k) => (row[k] == null ? "" : String(row[k]))))])) console.log(line);
    });

  transcript
    .command("prune")
    .description("Delete local transcripts whose copy in the store matches byte for byte")
    .argument("[session-id...]", "session ids (a unique prefix is enough)")
    .option("--ended", "every local session that is not running")
    .option("--archived", "every local session marked archived and not running")
    .option("--json", "print as JSON")
    .action(async (ids: string[], o) => {
      const c = await client();
      const { picked, running } = await select(ids, { ended: Boolean(o.ended), archived: Boolean(o.archived) }, { excludeRunning: true });
      const results = [];
      let refused = 0;
      for (const t of picked) {
        let r: Awaited<ReturnType<typeof c.prune>>;
        try {
          r = await c.prune(t, running);
        } catch (e) {
          // 消すかどうかを決められなかったものは消していない。残りは続ける
          const error = e instanceof Error ? e.message : String(e);
          console.error(`(${t.sessionId}: not pruned: ${error})`);
          results.push({ sessionId: t.sessionId, status: "failed", error });
          refused += 1;
          continue;
        }
        results.push({ sessionId: t.sessionId, ...r });
        if (r.status === "refused") refused += 1;
        if (!o.json) console.log(`${r.status.padEnd(7)} ${t.sessionId}  ${r.reason ?? t.path}`);
      }
      if (o.json) console.log(JSON.stringify(results, null, 2));
      // 1 件でも断ったら非 0。「全部消えた」と読まれないように
      if (refused) process.exitCode = 1;
    });
}

/**
 * 1 件の pull。transcript を戻せたら、その後の repodir (mirror の更新を含む) の失敗は警告にして
 * repodirError に入れ、失敗にしない: 本体は戻っており、呼び出し側が exit 1 を pull の失敗と読んで
 * push / resume を飛ばす (#168)
 */
async function pullOne(
  c: TranscriptClient,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  VERSION: string,
  idOrPrefix: string,
  o: { force?: boolean; repodir?: boolean; json?: boolean },
): Promise<Record<string, unknown>> {
  const id = await c.resolve(idOrPrefix);
  if (!id) throw new Error(`no session in the store matches ${idOrPrefix}`);
  const r = await c.pull(id, claudeHome(), Boolean(o.force));
  // pull が手元に写した宣言状態も center に報告する (mark と同じ経路。手元に書いた唯一の他の場所)
  if (r.stateApplied && r.state) await reportState(cfg.hub, cfg.machine, id, r.state);
  if (r.stateError) console.error(`(${id}: the store's state was not applied: this machine's declared state could not be read: ${r.stateError})`);

  // 会話だけでは作業できない。session.json の repo から、default branch の最新で
  // 作業場所を作る (元の branch には戻さない: 未 push の続きは transcript に無い)。
  // Claude Code は session を id で引くので、JSONL の置き場所と cwd は一致しなくてよい (#110)
  let repodir: string | undefined;
  let repodirError: string | undefined;
  if (o.repodir !== false && r.meta.repo) {
    try {
      const spec = parseRepoSpec(r.meta.repo, { defaultHost: cfg.defaultHost, defaultOwner: cfg.defaultOwner });
      repodir = (await createRepodir(cfg, spec, { initialTask: `resume session ${id}`, refresh: true }, VERSION)).path;
    } catch (e) {
      repodirError = e instanceof Error ? e.message : String(e);
      console.error(`(${id}: the transcript is in place, but no repodir: ${repodirError})`);
    }
  }
  const result = { sessionId: id, ...r, repodir, repodirError };
  if (o.json) return result;

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
    const meta = Object.keys(r.state.metadata);
    const parts = [flagsOf(r.state).join(","), r.state.label && `label: ${r.state.label}`, r.state.task && `task: ${r.state.task}`, r.state.role && `role: ${r.state.role}`, meta.length > 0 && `metadata: ${meta.join(",")}`].filter(Boolean);
    if (parts.length) console.log(`state         ${parts.join("  ")}${r.stateApplied ? "" : "  (not applied: this machine already holds marks for this session)"}`);
  }
  return result;
}
