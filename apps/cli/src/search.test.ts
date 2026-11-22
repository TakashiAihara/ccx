/**
 * 同梱 DuckDB が、center の object API に置いた transcript を httpfs で読めること。
 * 検索の判別能力は、存在する語と存在しない語の両方で見る。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "@ccx/hub/src/db/open.ts";
import { ObjectStore } from "@ccx/hub/src/objects.ts";
import { createApp } from "@ccx/hub/src/server.ts";

import { encodeCwd, localTranscripts, TranscriptClient, writeDeclared, type TranscriptStore } from "@ccx/core";

import { openDuckDB } from "./duckdb.ts";
import { SEARCH_VIEW_COLUMNS } from "./transcript.ts";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const SID2 = "1a2b3c4d-5e6f-4a70-8b9c-0d1e2f3a4b5c";

let server: ReturnType<typeof Bun.serve>;
let db: ReturnType<typeof openDb>;
let root: string;
let home: string;
let store: TranscriptStore;
/** 本物の ~/.cache に 90 MB を書かない */
let cacheHome: string;

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-search-"));
  home = await mkdtemp(join(tmpdir(), "ccx-search-home-"));
  cacheHome = await mkdtemp(join(tmpdir(), "ccx-search-cache-"));
  process.env.XDG_CACHE_HOME = cacheHome;
  db = openDb(":memory:");
  const app = createApp(db, new ObjectStore(root));
  tokens = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, srv) => {
      tokens.push(req.headers.get("x-amz-security-token"));
      auths.push(req.headers.get("authorization"));
      return app.fetch(req, srv);
    },
  });
  store = { endpoint: `http://127.0.0.1:${server.port}`, bucket: "ccx", prefix: "pre/" };

  const projectDir = join(home, "projects", encodeCwd("/w"));
  await mkdir(projectDir, { recursive: true });
  await Bun.write(
    join(projectDir, `${SID}.jsonl`),
    [
      line({ type: "user", cwd: "/w", timestamp: "2026-09-19T00:00:01Z", message: { role: "user", content: "find the NEEDLE-ALPHA please, 100% sure" } }),
      line({ type: "assistant", cwd: "/w", timestamp: "2026-09-19T00:00:02Z", message: { model: "claude-opus-5", usage: { output_tokens: 7 } } }),
    ].join(""),
  );
  await Bun.write(
    join(projectDir, `${SID2}.jsonl`),
    line({ type: "user", cwd: "/w", timestamp: "2026-09-19T00:00:03Z", message: { role: "user", content: "nothing here" } }),
  );
  // SID2 だけに宣言状態 (state.json) を置く。SID には無い: 無い session の検索が止まらないことも見る
  await writeDeclared(SID2, { label: "ORIGINAL-NAME" }, home);
  await writeDeclared(SID2, { label: "renamed-now", role: "night-shift", metadata: { owner: "zed" } }, home);
  const client = new TranscriptClient(store, { machine: "host-a", user: "alice" });
  for (const t of await localTranscripts(home)) await client.push(t, home);
});

/** 本物のコマンドを、この store を向けて走らせる */
/** center 役が受けた x-amz-security-token と authorization (#213) */
let tokens: (string | null)[] = [];
let auths: (string | null)[] = [];

async function ccx(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "search", ...args], {
    env: { ...process.env, CCX_HUB_URL: store.endpoint, CCX_TRANSCRIPT_PREFIX: "pre", XDG_CONFIG_HOME: root, XDG_CACHE_HOME: cacheHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await Promise.all([root, home, cacheHome].map((d) => rm(d, { recursive: true, force: true })));
});

describe("search: embedded DuckDB over the store", () => {
  test("--help lists every view's columns as the views have them, and its JSON-path example runs (#345)", async () => {
    const c = await openDuckDB(store, { withHistory: true });
    for (const [view, cols] of Object.entries(SEARCH_VIEW_COLUMNS)) {
      const described = (await c.runAndReadAll(`SELECT column_name FROM (DESCRIBE ${view})`)).getRowObjectsJson().map((r) => r.column_name);
      expect([view, ...described]).toEqual([view, ...cols]);
    }

    const help = await ccx("--help");
    expect(help.code).toBe(0);
    for (const [view, cols] of Object.entries(SEARCH_VIEW_COLUMNS)) expect(help.out).toContain(`  ${view.padEnd(11)}  ${cols.join(", ")}\n`);
    expect(help.out).toContain("  transcripts  the record keys found in the first 32 files, then machine, session_id, user\n");
    const example = help.out.match(/ccx tr search --sql "([^"]+)"/)?.[1];
    expect(example).toContain("json->>'$.type' = 'user'");
    const ran = await ccx("--sql", example!, "--json");
    expect(ran.code).toBe(0);
    const rows = (JSON.parse(ran.out) as { session_id: string; content: string }[]).sort((x, y) => x.session_id.localeCompare(y.session_id));
    expect(rows).toEqual([
      { session_id: SID, content: "find the NEEDLE-ALPHA please, 100% sure" },
      { session_id: SID2, content: "nothing here" },
    ]);
  });

  test("transcripts view carries the hive columns and message fields; a present word hits, an absent one does not", async () => {
    const c = await openDuckDB(store, { withHistory: true, withTranscripts: true });

    const rows = await c.runAndReadAll(`SELECT session_id, machine, "user", type FROM transcripts ORDER BY timestamp`);
    expect(rows.getRowObjectsJson()).toEqual([
      { session_id: SID, machine: "host-a", user: "alice", type: "user" },
      { session_id: SID, machine: "host-a", user: "alice", type: "assistant" },
      { session_id: SID2, machine: "host-a", user: "alice", type: "user" },
    ]);

    const model = await c.runAndReadAll(`SELECT message.model AS m, message.usage.output_tokens AS n FROM transcripts WHERE type = 'assistant'`);
    expect(model.getRowObjectsJson()).toEqual([{ m: "claude-opus-5", n: "7" }]);

    const hit = await c.runAndReadAll(`SELECT session_id FROM lines WHERE contains(lower(json::VARCHAR), 'needle-alpha')`);
    expect(hit.getRowObjectsJson()).toEqual([{ session_id: SID }]);
    const miss = await c.runAndReadAll(`SELECT count(*) AS n FROM lines WHERE contains(lower(json::VARCHAR), 'needle-omega')`);
    expect(miss.getRowObjectsJson()).toEqual([{ n: "0" }]);
    // 生の行を探しているか: "usage" は assistant の 1 行にしか無い。構造化した struct を
    // to_json すると "usage":null が全行に出て 3 行当たる
    const keyOnly = await c.runAndReadAll(`SELECT count(*) AS n FROM lines WHERE contains(json::VARCHAR, 'usage')`);
    expect(keyOnly.getRowObjectsJson()).toEqual([{ n: "1" }]);

    // B が pull した記録は machine=host-b と出る (hive の machine=host-a に隠されない)
    const B = new TranscriptClient(store, { machine: "host-b", user: "bob" });
    // 別の home へ (同じ home だと already-here で履歴が書かれない)
    const homeB = await mkdtemp(join(tmpdir(), "ccx-search-homeB-"));
    try {
      expect((await B.pull(SID, homeB)).status).toBe("pulled");
    } finally {
      await rm(homeB, { recursive: true, force: true });
    }
    const c2 = await openDuckDB(store, { withHistory: true });
    const history = await c2.runAndReadAll(`SELECT session_id, op, machine, "user", pushed_by_machine, pushed_by_user FROM history ORDER BY session_id, occurred_at`);
    expect(history.getRowObjectsJson()).toEqual([
      { session_id: SID, op: "push", machine: "host-a", user: "alice", pushed_by_machine: "host-a", pushed_by_user: "alice" },
      { session_id: SID, op: "pull", machine: "host-b", user: "bob", pushed_by_machine: "host-a", pushed_by_user: "alice" },
      { session_id: SID2, op: "push", machine: "host-a", user: "alice", pushed_by_machine: "host-a", pushed_by_user: "alice" },
    ]);

    // session で絞ると、その session のファイルしか読まない
    const one = await openDuckDB(store, { session: SID2.slice(0, 8) });
    expect((await one.runAndReadAll(`SELECT DISTINCT session_id FROM lines`)).getRowObjectsJson()).toEqual([{ session_id: SID2 }]);
  });

  test("the command: case-insensitive, wildcards are literal, snippet lands on the match, --sql and --json", async () => {
    // 小文字で探して大文字の本文に当たる
    const hit = await ccx("needle-alpha", "--json");
    expect(hit.code).toBe(0);
    const rows = JSON.parse(hit.out) as { session_id: string; snippet: string }[];
    expect(rows.map((r) => r.session_id)).toEqual([SID]);
    expect(rows[0]!.snippet).toContain("NEEDLE-ALPHA");

    // `%` と `_` は LIKE のワイルドカードではなく文字。`needle_alpha` は `needle-alpha` に当たらない
    const pct = await ccx("100%", "--json");
    expect((JSON.parse(pct.out) as unknown[]).length).toBe(1);
    const underscore = await ccx("needle_alpha", "--json");
    expect(JSON.parse(underscore.out)).toEqual([]);

    const miss = await ccx("needle-omega");
    expect(miss.code).toBe(0);
    expect(miss.err).toContain("no match");

    const sql = await ccx("--sql", "SELECT machine, count(*) AS n FROM transcripts GROUP BY 1", "--json");
    expect(JSON.parse(sql.out)).toEqual([{ machine: "host-a", n: "3" }]);

    const table = await ccx("needle", "-s", SID2.slice(0, 8));
    expect(table.err).toContain("no match");

    // 混ぜられない組み合わせは黙って捨てず止まる
    expect((await ccx("x", "--sql", "SELECT 1")).code).toBe(1);
    expect((await ccx("--sql", "SELECT 1", "-n", "2")).code).toBe(1);
    // --sql の history は操作した側の machine を出す
    const hist = await ccx("--sql", "SELECT op, machine FROM history ORDER BY occurred_at", "--json");
    expect(JSON.parse(hist.out)).toEqual([
      { op: "push", machine: "host-a" },
      { op: "push", machine: "host-a" },
    ]);
    // 9 runs of ccx at 350-650 ms of CPU each: on a loaded host their combined wall time passes bun's default 5 s (#363)
  }, 20_000);

  test("only a query that names `transcripts` builds it: building it reads files to infer their types (#300)", async () => {
    const c = await openDuckDB(store);
    await expect(c.runAndReadAll("SELECT 1 FROM transcripts")).rejects.toThrow("Table with name transcripts does not exist");
    expect((await c.runAndReadAll("SELECT count(*) AS n FROM lines")).getRowObjectsJson()).toEqual([{ n: "3" }]);
  });

  test("--sql builds `transcripts` only when the query reads it as a table, not for the word in a path or a string (#325)", async () => {
    const json = async (sql: string) => {
      const r = await ccx("--sql", sql, "--json");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      return JSON.parse(r.out) as unknown;
    };
    expect(await json(`SELECT count(*) AS n FROM duckdb_views() WHERE view_name = 'transcripts' OR 's3://x/transcripts/y' = ''`)).toEqual([{ n: "0" }]);
    // The shape #325 is about: a query over `lines` whose filter holds a store path
    expect(await json(`SELECT (SELECT count(*) FROM duckdb_views() WHERE view_name = 'transcripts') AS n FROM lines WHERE 's3://x/transcripts/y' <> '' LIMIT 1`)).toEqual([{ n: "0" }]);
    // The table in any case, inside a subquery, and in a later statement of several
    expect(await json(`SELECT (SELECT count(*) FROM TRANSCRIPTS) AS n`)).toEqual([{ n: "3" }]);
    expect(await json(`SET threads = 1; SELECT count(*) AS n FROM transcripts`)).toEqual([{ n: "3" }]);
    expect(await json(`SELECT count(*) AS n FROM main."transcripts"`)).toEqual([{ n: "3" }]);
    expect(await json(`PREPARE p AS SELECT count(*) AS n FROM transcripts; EXECUTE p`)).toEqual([{ n: "3" }]);
    expect(await json(`SELECT count(*) AS n FROM query_table('transcripts')`)).toEqual([{ n: "3" }]);
    expect(await json(`SELECT n FROM query('SELECT count(*) AS n FROM transcripts')`)).toEqual([{ n: "3" }]);
    expect(((await json(`DESCRIBE transcripts`)) as { column_name: string }[]).map((r) => r.column_name)).toContain("session_id");
    // A statement that cannot bind before the one ahead of it runs (a table it creates, bound first) still gets the view
    expect(await json(`CREATE TEMP TABLE t AS SELECT 1 AS a; SELECT count(*) AS n FROM t CROSS JOIN transcripts`)).toEqual([{ n: "3" }]);
    // A name an earlier statement sets binds as NULL (a Binder Error), and still gets the view
    expect(await json(`SET VARIABLE t = 'transcripts'; SELECT count(*) AS n FROM query_table(getvariable('t'))`)).toEqual([{ n: "3" }]);
    // Errors in the query are the run's to report, whether or not the view was built
    const bad = await ccx("--sql", "SELECT count(*) FROM no_such_table WHERE 'transcripts' = ''");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("Table with name no_such_table does not exist");
    const unparsable = await ccx("--sql", "SELEC * FROM transcripts");
    expect(unparsable.code).not.toBe(0);
    expect(unparsable.err).toContain(`syntax error at or near "SELEC"`);
    // 13 runs of ccx: past bun's default 5 s on a loaded host
  }, 20_000);

  test("building `transcripts` infers its types from a sample of files, not from every transcript in the store (#300)", async () => {
    // Inferring from every file passed 3 GB on 1304 files before the query ran. A broken file past the sample
    // stands in for "a file the inference read": building the view (which samples) must not touch it.
    // Each bulk record also carries a key of its own, as rare keys do in real transcripts: on average a key then appears
    // in under 10% of records, and DuckDB's default inference turns the whole record into one MAP column
    const at = (m: string, sid: string) => join(root, "ccx", "pre", "transcripts", `machine=${m}`, "user=u", `session_id=${sid}`, "transcript.jsonl");
    await Promise.all(Array.from({ length: 40 }, (_, i) => Bun.write(at("m-bulk", `s${String(i).padStart(2, "0")}`), line({ type: "user", [`only${i}`]: i, message: { content: `bulk ${i}`, ...(i >= 30 ? { late: i } : {}) } }))));
    await Bun.write(at("zz-late", "broken"), "{not json\n");
    const c = await openDuckDB(store, { withTranscripts: true });
    const names = (await c.runAndReadAll("SELECT column_name FROM (DESCRIBE transcripts)")).getRowObjectsJson().map((r) => r.column_name);
    expect(names).toContain("message");
    expect(names).toContain("type");
    expect(names).toContain("session_id");
    // The two host-a transcripts and s00..s29 make the 32 sampled files; s30..s39 come after them
    expect(names).toContain("only29");
    expect(names).not.toContain("only30");

    await rm(at("zz-late", "broken"));
    const r = await c.runAndReadAll("SELECT count(*)::INT AS n, count(only5)::INT AS five FROM transcripts WHERE machine = 'm-bulk'");
    expect(r.getRowObjects()[0]).toEqual({ n: 40, five: 1 });
    // SELECT * reads whole records, where an inferred schema rejects the keys the sample lacks (only30.., message.late)
    const all = await c.runAndReadAll("SELECT * FROM transcripts WHERE machine = 'm-bulk' AND session_id = 's31'");
    expect(all.getRowObjectsJson()).toHaveLength(1);
    const late = all.getRowObjectsJson()[0]!;
    expect(late.message).toEqual({ role: null, content: "bulk 31", model: null, usage: null });
    expect(late.only29).toBeNull();
    expect(Object.keys(late)).not.toContain("only31");
    expect((await c.runAndReadAll("SELECT count(*)::INT AS n FROM (SELECT * FROM transcripts WHERE machine = 'm-bulk')")).getRowObjects()[0]).toEqual({ n: 40 });

    // A later value that does not fit the sampled type fails the query, not drops or nulls the record
    await Bun.write(at("zz-late", "typed"), line({ type: "user", only5: { not: "a number" } }));
    await expect(c.runAndReadAll("SELECT * FROM transcripts")).rejects.toThrow("JSON transform error");
  });

  test("a date in a non-ISO format reads back as the same string, and the timestamp stays text to cast (#300)", async () => {
    const dir = join(root, "ccx", "pre", "transcripts", "machine=aa-dates", "user=u");
    await Bun.write(join(dir, "session_id=d1", "transcript.jsonl"), line({ type: "user", timestamp: "2026-09-19T00:00:04Z", input: { due: "17-11-2026", "delivery DATE format": "keep", DATE: "named" } }));
    const c = await openDuckDB(store, { withTranscripts: true });
    const types = Object.fromEntries((await c.runAndReadAll("SELECT column_name, column_type FROM (DESCRIBE transcripts)")).getRowObjectsJson().map((r) => [r.column_name, r.column_type]));
    expect(types.timestamp).toBe("VARCHAR");
    expect(types.input).toBe('STRUCT(due VARCHAR, "delivery DATE format" VARCHAR, DATE VARCHAR)');
    expect((await c.runAndReadAll(`SELECT input."DATE" AS d FROM transcripts WHERE session_id = 'd1'`)).getRowObjectsJson()).toEqual([{ d: "named" }]);
    const r = await c.runAndReadAll(`SELECT input.due AS due, input."delivery DATE format" AS kept, timestamp::TIMESTAMP::VARCHAR AS at FROM transcripts WHERE session_id = 'd1'`);
    expect(r.getRowObjectsJson()).toEqual([{ due: "17-11-2026", kept: "keep", at: "2026-09-19 00:00:04" }]);
    expect((await c.runAndReadAll("SELECT * FROM transcripts")).getRowObjects()).toHaveLength(4);
  });

  test("a records-less sample is refused even when the prefix carries its own key=value segment (#300)", async () => {
    const team: TranscriptStore = { ...store, prefix: "team=demo/" };
    const at = (sid: string) => join(root, "ccx", "team=demo", "transcripts", "machine=aa-empty", "user=u", `session_id=${sid}`, "transcript.jsonl");
    await Promise.all(Array.from({ length: 32 }, (_, i) => Bun.write(at(`e${String(i).padStart(2, "0")}`), "")));
    await Bun.write(at("z-real"), line({ type: "user", message: { content: "hello" } }));
    await expect(openDuckDB(team, { withTranscripts: true })).rejects.toThrow("hold no record keys");

    // With records in the sample, the prefix's `team` is no column of the view, and a record's own `user` does not
    // replace the path's user
    await Promise.all(Array.from({ length: 32 }, (_, i) => rm(at(`e${String(i).padStart(2, "0")}`))));
    await Bun.write(at("a-real"), line({ type: "user", user: { id: 1 }, message: { content: "first" } }));
    await Bun.write(at("z-real"), line({ type: "user", user: "someone", message: { content: "hello" } }));
    const c = await openDuckDB(team, { withTranscripts: true });
    const names = (await c.runAndReadAll("SELECT column_name FROM (DESCRIBE transcripts)")).getRowObjectsJson().map((r) => r.column_name);
    expect(names).not.toContain("team");
    expect((await c.runAndReadAll(`SELECT * FROM transcripts ORDER BY session_id`)).getRowObjectsJson().map((r) => [r.session_id, r.user])).toEqual([
      ["a-real", "u"],
      ["z-real", "u"],
    ]);
  });

  test("a sample of transcripts with no records refuses to build `transcripts` instead of reading every record as NULL (#300)", async () => {
    const at = (sid: string) => join(root, "ccx", "pre", "transcripts", "machine=aa-empty", "user=u", `session_id=${sid}`, "transcript.jsonl");
    await Promise.all(Array.from({ length: 32 }, (_, i) => Bun.write(at(`e${String(i).padStart(2, "0")}`), "")));

    await expect(openDuckDB(store, { withTranscripts: true })).rejects.toThrow("the transcripts DuckDB samples first (up to 32, in path order) hold no record keys");
    const c = await openDuckDB(store);
    expect((await c.runAndReadAll("SELECT count(*)::INT AS n FROM lines")).getRowObjects()[0]).toEqual({ n: 3 });

    // Records with only the keys the view takes from the path leave no column either
    await Promise.all(Array.from({ length: 32 }, (_, i) => Bun.write(at(`e${String(i).padStart(2, "0")}`), line({ session_id: "x", user: "y" }))));
    await expect(openDuckDB(store, { withTranscripts: true })).rejects.toThrow("hold no record keys besides session_id / machine / user");
  });

  test("reading the store keeps none of its bytes in DuckDB's external file cache (#300)", async () => {
    const c = await openDuckDB(store);
    expect((await c.runAndReadAll("SELECT count(*) AS n FROM lines WHERE contains(json::VARCHAR, 'NEEDLE-ALPHA')")).getRowObjectsJson()).toEqual([{ n: "1" }]);
    expect((await c.runAndReadAll("SELECT count(*) AS n FROM duckdb_external_file_cache()")).getRowObjectsJson()).toEqual([{ n: "0" }]);
    // The 0 above means something only if this DuckDB caches reads of objects this small at all
    await c.run("SET enable_external_file_cache = true");
    await c.runAndReadAll("SELECT count(*) FROM lines");
    expect(Number((await c.runAndReadAll("SELECT count(*) AS n FROM duckdb_external_file_cache()")).getRowObjectsJson()[0]!.n)).toBeGreaterThan(0);
  });

  test("a search that grows past CCX_SEARCH_MAX_RSS_MB stops with an error instead of running on (#300)", async () => {
    const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "search", "--sql", "SELECT count(*) FROM range(1000000000000)"], {
      env: { ...process.env, CCX_HUB_URL: store.endpoint, CCX_TRANSCRIPT_PREFIX: "pre", XDG_CONFIG_HOME: root, XDG_CACHE_HOME: cacheHome, CCX_SEARCH_MAX_RSS_MB: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const started = Date.now();
    const killer = setTimeout(() => p.kill(9), 20_000);
    const [, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(killer);
    expect(code).toBe(1);
    expect(err).toContain("over 1 MiB; stopped before it takes the host down");
    // range(1e11) took 16 s on d1, so this one takes minutes; only the guard ends it this soon
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  test("sessions view: label, its history and metadata from state.json, and the default search finds a session by a past name", async () => {
    const c = await openDuckDB(store);
    const rows = (await c.runAndReadAll(`SELECT session_id, machine, label, role, archived, metadata, label_history, label_recorded_at FROM sessions`)).getRowObjectsJson();
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, unknown>;
    expect({ id: r.session_id, machine: r.machine, label: r.label, role: r.role, archived: r.archived }).toEqual({ id: SID2, machine: "host-a", label: "renamed-now", role: "night-shift", archived: false });
    expect(JSON.parse(String(r.metadata))).toEqual({ owner: "zed" });
    const history = JSON.parse(String(r.label_history)) as { at: string; label: string }[];
    expect(history.map((e) => e.label)).toEqual(["ORIGINAL-NAME", "renamed-now"]);
    expect(r.label_recorded_at).toBe(history[1]!.at);

    // 今の名前でも、前の名前 (履歴にしか無い) でも、metadata の値でも当たる。行は type = ccx.state
    for (const word of ["renamed-now", "original-name", "zed", "night-shift"]) {
      const hit = await ccx(word, "--json");
      expect(hit.code).toBe(0);
      expect((JSON.parse(hit.out) as { session_id: string; type: string }[]).map((x) => [x.session_id, x.type])).toEqual([[SID2, "ccx.state"]]);
    }
    // state.json のキー名には当たらない (丸ごと文字列にしていない)。metadata の key は当たる (値の無い key は key が中身)
    for (const key of ["label", "archived", "labelhistory"]) expect((await ccx(key)).err).toContain("no match");
    // 過去の label どうしは改行で区切る: 2 つにまたがる語は当たらない
    expect((await ccx("original-name renamed-now")).err).toContain("no match");
    expect((JSON.parse((await ccx("owner", "--json")).out) as { session_id: string }[]).map((x) => x.session_id)).toEqual([SID2]);

    // state.json の無い session に絞っても (sessions は 0 行)、検索は動く
    const only = await ccx("needle-alpha", "-s", SID.slice(0, 8), "--json");
    expect(only.code).toBe(0);
    expect((JSON.parse(only.out) as { session_id: string }[]).map((x) => x.session_id)).toEqual([SID]);
    // ccx を 10 回起動する。1 回 0.2s 前後で、全体を並べて流すと既定の 5s を越えることがある
  }, 20_000);

  // Each trap prefix also ends in one view's leaf name, so the match has to be the one right above the real file
  for (const leaf of ["transcript.jsonl", "state.json", "history/1.json"]) {
    test(`every view takes machine / user / session_id from the segments after the prefix, not from key=value segments in the prefix ending in ${leaf} (#171)`, async () => {
      const prefix = `machine=trap-m/user=trap-u/session_id=trap-s/${leaf}/`;
      const trap: TranscriptStore = { ...store, prefix };
      const client = new TranscriptClient(trap, { machine: "host-a", user: "alice" });
      for (const t of await localTranscripts(home)) await client.push(t, home);

      const c = await openDuckDB(trap, { withHistory: true, withTranscripts: true });
      const want = [
        { session_id: SID, machine: "host-a", user: "alice" },
        { session_id: SID2, machine: "host-a", user: "alice" },
      ];
      const pick = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
      expect(await pick(`SELECT DISTINCT session_id, machine, "user" FROM lines ORDER BY session_id`)).toEqual(want);
      expect(await pick(`SELECT DISTINCT session_id, machine, "user" FROM transcripts ORDER BY session_id`)).toEqual(want);
      expect(await pick(`SELECT session_id, machine, "user" FROM sessions`)).toEqual([want[1]!]);
      expect(await pick(`SELECT session_id, pushed_by_machine AS machine, pushed_by_user AS "user" FROM history ORDER BY session_id`)).toEqual(want);
    });
  }

  test("transcripts keeps the path's session_id / machine / user over a record's own keys, without the reader's path column, in hive order (#171)", async () => {
    const recDir = join(root, "ccx", "pre", "transcripts", "machine=host-q", "user=quinn", "session_id=rec-1");
    await Bun.write(join(recDir, "transcript.jsonl"), line({ type: "user", session_id: "REC-S", machine: "REC-M", user: "REC-U" }));
    const c = await openDuckDB(store, { withTranscripts: true });
    const pick = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
    expect(await pick(`SELECT DISTINCT session_id, machine, "user" FROM transcripts ORDER BY session_id`)).toEqual([
      { session_id: SID, machine: "host-a", user: "alice" },
      { session_id: SID2, machine: "host-a", user: "alice" },
      { session_id: "rec-1", machine: "host-q", user: "quinn" },
    ]);
    const names = (await pick(`SELECT column_name FROM (DESCRIBE transcripts)`)).map((r) => r.column_name);
    expect(names.slice(-3)).toEqual(["machine", "session_id", "user"]);
    expect(names.filter((n) => n === "__ccx_path" || /^(session_id|machine|user)_\d+$/.test(String(n)))).toEqual([]);
  });

  test("search ignores a persistent DuckDB secret the user saved for s3://ccx (#213)", async () => {
    const userHome = join(root, "user-home");
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    await conn.run(`SET secret_directory = '${join(userHome, ".duckdb", "stored_secrets")}'`);
    await conn.run("CREATE PERSISTENT SECRET mine (TYPE s3, KEY_ID 'USER-REAL-KEY', SECRET 'x', SCOPE 's3://ccx')");
    conn.closeSync();
    auths = [];
    const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "search", "needle-alpha", "--json"], {
      env: { ...process.env, HOME: userHome, CCX_HUB_URL: store.endpoint, CCX_TRANSCRIPT_PREFIX: "pre", XDG_CONFIG_HOME: root, XDG_CACHE_HOME: cacheHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    expect(auths.length).toBeGreaterThan(0);
    expect(auths.filter((a) => a?.includes("USER-REAL-KEY"))).toEqual([]);
  });

  test("search does not send the env's AWS session token to the center (#213)", async () => {
    tokens = [];
    const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "search", "needle-alpha", "--json"], {
      env: { ...process.env, AWS_SESSION_TOKEN: "LEAKED-TOKEN", CCX_HUB_URL: store.endpoint, CCX_TRANSCRIPT_PREFIX: "pre", XDG_CONFIG_HOME: root, XDG_CACHE_HOME: cacheHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((v) => v?.includes("LEAKED-TOKEN"))).toEqual([]);
  });

  test("a history file that is not JSON, not an object, or lacks a string op / machine / user / at drops only itself, in --sql and in tr ls; no history at all is 0 rows (#172)", async () => {
    const histDir = join(root, "ccx", "pre", "transcripts", "machine=host-a", "user=alice", `session_id=${SID}`, "history");
    await Bun.write(join(histDir, "1-push-host-a-deadbeef.json"), '{"op": "pu');
    await Bun.write(join(histDir, "2-push-host-a-cafef00d.json"), "[]");
    await Bun.write(join(histDir, "3-push-host-a-00000000.json"), "null");
    // 4 つの値それぞれについて、欠けたもの・文字列でないもの
    const good = { op: "pull", machine: "host-z", user: "zed", at: "2026-01-01T00:00:00.000Z" };
    let n = 10;
    for (const k of ["op", "machine", "user", "at"] as const) {
      const { [k]: _, ...missing } = good;
      await Bun.write(join(histDir, `${n++}-pull-host-z-${k}.json`), JSON.stringify(missing));
      await Bun.write(join(histDir, `${n++}-pull-host-z-${k}.json`), JSON.stringify({ ...good, [k]: 1 }));
    }
    const hist = await ccx("--sql", "SELECT session_id, op FROM history ORDER BY session_id", "--json");
    expect(hist.code).toBe(0);
    expect(JSON.parse(hist.out)).toEqual([{ session_id: SID, op: "push" }, { session_id: SID2, op: "push" }]);
    const client = new TranscriptClient(store, { machine: "host-a", user: "alice" });
    const meta = (await client.find(SID))!;
    expect(await client.history(meta)).toStrictEqual([{ op: "push", machine: "host-a", user: "alice", at: expect.any(String) }]);

    await rm(histDir, { recursive: true });
    const c = await openDuckDB(store, { withHistory: true, session: SID.slice(0, 8) });
    expect((await c.runAndReadAll("SELECT count(*) AS n FROM history")).getRowObjectsJson()).toEqual([{ n: "0" }]);
  });

  test("a state row with no ccx label history still comes before transcript hits; a malformed state.json drops only itself", async () => {
    const dir = (m: string, id: string) => join(root, "ccx", "pre", "transcripts", `machine=${m}`, "user=u", `session_id=${id}`);
    const SID3 = "2b3c4d5e-6f70-4a81-9c0d-1e2f3a4b5c6d";
    // metadata だけの state (時刻が NULL になる)。transcript の当たり (NEEDLE-ALPHA の行) と同じ語を持たせる
    await mkdir(dir("host-z", SID3), { recursive: true });
    await Bun.write(join(dir("host-z", SID3), "state.json"), JSON.stringify({ archived: false, label: "", task: "", metadata: { topic: "needle-alpha" } }, null, 2));
    // 壊れた state.json
    await mkdir(dir("host-y", SID3), { recursive: true });
    await Bun.write(join(dir("host-y", SID3), "state.json"), '{"label": "needle-alpha');
    // JSON としては正しいが型が違う (host-w) / 正しい型 (host-v) / 鍵が無い (host-u)
    await mkdir(dir("host-w", SID3), { recursive: true });
    await Bun.write(join(dir("host-w", SID3), "state.json"), JSON.stringify({ archived: "true", label: "odd-one" }));
    await mkdir(dir("host-v", SID3), { recursive: true });
    await Bun.write(join(dir("host-v", SID3), "state.json"), JSON.stringify({ archived: true, label: "odd-one" }));
    await mkdir(dir("host-u", SID3), { recursive: true });
    await Bun.write(join(dir("host-u", SID3), "state.json"), JSON.stringify({ label: "odd-one" }));
    // JSON の true だけが真 (core の normalizeDeclared と同じ読み)
    const odd = await ccx("--sql", "SELECT machine, archived FROM sessions WHERE label = 'odd-one' ORDER BY machine", "--json");
    expect(odd.code).toBe(0);
    expect(JSON.parse(odd.out)).toEqual([
      { machine: "host-u", archived: false },
      { machine: "host-v", archived: true },
      { machine: "host-w", archived: false },
    ]);

    const r = await ccx("needle-alpha", "-n", "1", "--json");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { session_id: string; machine: string; type: string }[]).map((x) => [x.session_id, x.machine, x.type])).toEqual([[SID3, "host-z", "ccx.state"]]);
    const all = await ccx("needle-alpha", "--json");
    expect((JSON.parse(all.out) as { session_id: string; type: string }[]).map((x) => [x.session_id, x.type])).toEqual([
      [SID3, "ccx.state"],
      [SID, "user"],
    ]);
  });

  test("a store past one list page (1000 keys) is read whole, with & in the key at the page boundary", async () => {
    // center の一覧が 2 ページ目に進めないと glob が終わらない (#173)。token が key の形だと
    // `&` が `&amp;` のまま送り返され、境界の key (`x&00999`) より後ろが丸ごと落ちる。
    // ObjectStore はファイルが真実源なので直接置く
    const dir = join(root, "ccx", "pre", "transcripts", "machine=bulk", "user=u");
    const n = 1100;
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const sid = `x&${String(i).padStart(5, "0")}`;
        return Bun.write(join(dir, `session_id=${sid}`, "transcript.jsonl"), line({ type: "user", message: { content: `bulk ${i}` } }));
      }),
    );
    const c = await openDuckDB(store);
    const r = await c.runAndReadAll(`SELECT count(*)::INT AS rows, count(DISTINCT session_id)::INT AS sessions FROM lines WHERE machine = 'bulk'`);
    expect(r.getRowObjects()[0]).toEqual({ rows: n, sessions: n });
  }, 20_000);

  test("stats: per day, typed inputs, queued inputs, Esc and refusals; copies, forks, heartbeats and machine records are not counted", async () => {
    const at = (s: number) => new Date(Date.parse("2026-09-20T00:00:00Z") + s * 1000).toISOString();
    const tool = { type: "tool_use", id: "t", name: "Bash", input: {} };
    const human = { kind: "human" };
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    const a = [
      { uuid: "a1", type: "user", origin: human, timestamp: at(0), message: { content: "do X" } },
      { uuid: "a2", type: "assistant", timestamp: at(10), message: { content: [tool, tool] } },
      { uuid: "a3", type: "user", timestamp: at(20), message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
      { uuid: "a4", type: "assistant", timestamp: at(30), message: text("ok") },
      { type: "queue-operation", operation: "enqueue", timestamp: at(40), content: "also Y" },
      { type: "queue-operation", operation: "remove", timestamp: at(40.5) },
      // 入力欄に戻された (popAll) ものは数えない
      { type: "queue-operation", operation: "enqueue", timestamp: at(41), content: "pulled back" },
      { type: "queue-operation", operation: "popAll", timestamp: at(42) },
      { type: "queue-operation", operation: "enqueue", timestamp: at(45), content: "<task-notification>x</task-notification>" },
      // 通知で AI が続けた作業は「do X」の作業に含める
      { uuid: "a5", type: "user", origin: { kind: "task-notification" }, timestamp: at(90), message: { content: "<task-notification>x</task-notification>" } },
      { uuid: "a6", type: "assistant", timestamp: at(100), message: { content: [tool] } },
      // heartbeat への返事は応答に数えない: 次の待ちは 151s ではなく 100s から測る
      { uuid: "a7", type: "user", isMeta: true, origin: { kind: "channel" }, timestamp: at(150), message: { content: '<channel source="ccx" kind="heartbeat">' } },
      { uuid: "a8", type: "assistant", timestamp: at(151), message: text(".") },
      { uuid: "a9", type: "user", origin: human, timestamp: at(160), message: { content: "next" } },
      { uuid: "a10", type: "assistant", timestamp: at(170), message: { content: [tool] } },
      { uuid: "a11", type: "user", timestamp: at(175), toolDenialKind: "user-rejected", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
      // tool を断ったときの付随記録は Esc ではない
      { uuid: "a12", type: "user", timestamp: at(176), message: text("[Request interrupted by user for tool use]") },
      { uuid: "a13", type: "user", timestamp: at(177), toolDenialKind: "permission-rule", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
      // session の終了で切れた tool は Esc ではない
      { uuid: "a14", type: "user", timestamp: at(178), toolDenialKind: "interrupted", toolUseResult: "[Tool call interrupted: the session ended before this call's result was recorded]", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
      { uuid: "a15", type: "user", timestamp: at(180), message: text("[Request interrupted by user]") },
      // 前に同じ本文を打っていても、後に user 記録が無い割り込みは数える
      { type: "queue-operation", operation: "enqueue", timestamp: at(185), content: "next" },
      { type: "queue-operation", operation: "remove", timestamp: at(185.5) },
      { type: "queue-operation", operation: "enqueue", timestamp: at(190), content: "next2" },
      { type: "queue-operation", operation: "dequeue", timestamp: at(199) },
      { uuid: "a16", type: "user", origin: human, timestamp: at(200), message: { content: "next2" } },
      { uuid: "a17", type: "assistant", timestamp: at(210), message: text("done") },
      { uuid: "a18", type: "user", isCompactSummary: true, timestamp: at(215), message: { content: "This session is being continued" } },
      // 人が打った slash command は数える
      { uuid: "a19", type: "user", origin: human, timestamp: at(216), message: { content: "<command-message>retro</command-message>" } },
      { uuid: "a20", type: "assistant", timestamp: at(217), message: text("retro") },
      { uuid: "a21", type: "user", isSidechain: true, origin: human, timestamp: at(220), message: { content: "subagent prompt" } },
      { uuid: "a22", type: "user", isMeta: true, timestamp: at(230), message: { content: "injected" } },
      // origin の無い古い版は本文で判定する。16:00Z は東京では翌日、UTC では同じ日。待ちは 6 時間を超えるので中央値に入れない
      { uuid: "a23", type: "user", timestamp: "2026-09-20T16:00:00Z", message: { content: "late" } },
    ];
    // 同じ日に並行して動いた別の session。turn と待ちを session ごとに切らないと「do X」の turn が割れる。
    // 「also Y」は stats-1 の割り込みと同じ本文だが、別の session の記録なので割り込みを打ち消さない
    const b = [
      { uuid: "b1", type: "user", origin: human, timestamp: at(5), message: { content: "other" } },
      { uuid: "b2", type: "assistant", timestamp: at(50), message: { content: [tool] } },
      // 待っている AI にすぐ取られた enqueue は割り込みではない
      { type: "queue-operation", operation: "enqueue", timestamp: at(59), content: "also Y" },
      { type: "queue-operation", operation: "dequeue", timestamp: at(59.5) },
      { uuid: "b3", type: "user", origin: human, timestamp: at(60), message: { content: "also Y" } },
      { uuid: "b4", type: "assistant", timestamp: at(70), message: text("ok") },
      // tool の実行中に押した Esc
      { uuid: "b5", type: "user", timestamp: at(75), toolDenialKind: "interrupted", toolUseResult: "Interrupted by user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
    ];
    // fork: 親の記録を同じ uuid で持つ。親の分は数えない
    const fork = [a[0]!, a[1]!, { uuid: "f1", type: "user", origin: human, timestamp: at(300), message: { content: "forked" } }, { uuid: "f2", type: "assistant", timestamp: at(310), message: { content: [tool] } }];
    // 規則の拒否だけの日と、何も無い日 (東京の 09-22)
    const quiet = [{ uuid: "q1", type: "user", timestamp: "2026-09-23T03:00:00Z", toolDenialKind: "permission-rule", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } }];
    const put = (machine: string, sid: string, recs: Record<string, unknown>[]) =>
      Bun.write(join(root, "ccx", "pre", "transcripts", `machine=${machine}`, "user=u", `session_id=${sid}`, "transcript.jsonl"), recs.map(line).join(""));
    await put("host-b", "stats-1", a);
    // 別の machine に残った古い写し (resume する前に push したもの)。行数の多い写しだけを読む
    await put("host-c", "stats-1", a.slice(0, 6));
    await put("host-b", "stats-2", b);
    await put("host-b", "stats-3", fork);
    await put("host-b", "stats-4", quiet);
    // 1 turn だけの日: 自走は 0→10、通知の 600→620、質問の答えの 5000→5010、enqueue の通知の 7000→7010 の和 50s。通知と人の答えを待った間は入れない。
    // 日を置いて開き直したときの合成の応答は AI の作業ではない
    const t5 = (s: number) => new Date(Date.parse("2026-09-25T00:00:00Z") + s * 1000).toISOString();
    await put("host-b", "stats-5", [
      { uuid: "s1", type: "user", origin: human, timestamp: t5(0), message: { content: "start a job" } },
      { uuid: "s2", type: "assistant", timestamp: t5(10), message: { content: [tool] } },
      { uuid: "s3", type: "user", origin: { kind: "task-notification" }, timestamp: t5(600), message: { content: "<task-notification>done</task-notification>" } },
      { uuid: "s4", type: "assistant", timestamp: t5(610), message: { content: [tool, tool] } },
      { uuid: "s5", type: "assistant", timestamp: t5(620), message: { content: [{ type: "tool_use", id: "ask1", name: "AskUserQuestion", input: {} }] } },
      { uuid: "s6", type: "user", timestamp: t5(5000), message: { content: [{ type: "tool_result", tool_use_id: "ask1" }] } },
      { uuid: "s7", type: "assistant", timestamp: t5(5010), message: text("thanks") },
      // 待っている AI に enqueue だけで届いた通知: 7000→7010 を足す (5010→7000 の待ちは入れない)
      { type: "queue-operation", operation: "enqueue", timestamp: t5(7000), content: "<task-notification>late</task-notification>" },
      { uuid: "s7b", type: "assistant", timestamp: t5(7010), message: text("noted") },
      { uuid: "s8", type: "assistant", timestamp: t5(90000), message: { model: "<synthetic>", ...text("No response requested.") } },
    ]);

    const { interactionSql } = await import("./stats.ts");
    const c = await openDuckDB(store);
    const tokyo = (await c.runAndReadAll(interactionSql("Asia/Tokyo"))).getRowObjectsJson();
    const day = (rows: typeof tokyo, d: string) => rows.find((r) => r.day === d);
    expect(day(tokyo, "2026-09-20")).toEqual({
      day: "2026-09-20",
      // 人の turn 7 (do X / next / next2 / retro / other / also Y / forked) + user 記録にならなかった割り込み 2 (also Y / next)
      prompts: 9,
      queued: 3,
      // 素の Esc (a15) と、tool の実行中の Esc (b5)。拒否に付いた印 (a12) は数えない
      interrupts: 2,
      rejected: 1,
      rule_denied: 1,
      turns: 7,
      // tool_use 3 / 1 / 0 / 0 / 1 / 0 / 1 の中央値
      tools_per_turn: 1,
      // 自走 40s (0→30 と通知の 90→100。通知を待った 60s と heartbeat は入れない) / 10s / 10s / 1s / 45s / 10s / 10s の中央値
      run_min_p50: 0.2,
      // 待ち 60s (heartbeat ではなく 100s の応答から) / 30s / 6s / 10s の中央値 20s
      wait_min_p50: 0.3,
      sessions: 3,
      machines: 1,
    });
    // 応答の無い turn の自走時間は 0 分ではなく測れない
    expect(day(tokyo, "2026-09-21")).toMatchObject({ prompts: 1, turns: 1, run_min_p50: null, wait_min_p50: null });
    expect(day(tokyo, "2026-09-22")).toEqual({
      day: "2026-09-22", prompts: 0, queued: 0, interrupts: 0, rejected: 0, rule_denied: 0, turns: 0,
      tools_per_turn: null, run_min_p50: null, wait_min_p50: null, sessions: 0, machines: 0,
    });
    expect(day(tokyo, "2026-09-23")).toMatchObject({ prompts: 0, rule_denied: 1, sessions: 0, machines: 1 });
    expect(day(tokyo, "2026-09-25")).toMatchObject({ prompts: 1, turns: 1, tools_per_turn: 4, run_min_p50: 0.8 });
    // beforeEach の 2 session (origin の無い古い形)
    expect(day(tokyo, "2026-09-19")).toMatchObject({ prompts: 2, sessions: 2 });

    const utc = (await c.runAndReadAll(interactionSql("UTC"))).getRowObjectsJson();
    expect(day(utc, "2026-09-20")?.prompts).toBe(10);
    expect(day(utc, "2026-09-21")?.prompts).toBe(0);
  });

  test("an empty store says so instead of a DuckDB IO error", async () => {
    await rm(join(root, "ccx"), { recursive: true, force: true });
    const r = await ccx("anything");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no transcripts yet");
  });
});
