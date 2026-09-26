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
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp(db, new ObjectStore(root)).fetch });
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
  await writeDeclared(SID2, { label: "renamed-now", metadata: { owner: "zed" } }, home);
  const client = new TranscriptClient(store, { machine: "host-a", user: "alice" });
  for (const t of await localTranscripts(home)) await client.push(t, home);
});

/** 本物のコマンドを、この store を向けて走らせる */
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
  test("transcripts view carries the hive columns and message fields; a present word hits, an absent one does not", async () => {
    const c = await openDuckDB(store, { withHistory: true });

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
    const history = await c2.runAndReadAll(`SELECT session_id, op, machine, "user", pushed_by_machine FROM history ORDER BY session_id, occurred_at`);
    expect(history.getRowObjectsJson()).toEqual([
      { session_id: SID, op: "push", machine: "host-a", user: "alice", pushed_by_machine: "host-a" },
      { session_id: SID, op: "pull", machine: "host-b", user: "bob", pushed_by_machine: "host-a" },
      { session_id: SID2, op: "push", machine: "host-a", user: "alice", pushed_by_machine: "host-a" },
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
  });

  test("sessions view: label, its history and metadata from state.json, and the default search finds a session by a past name", async () => {
    const c = await openDuckDB(store);
    const rows = (await c.runAndReadAll(`SELECT session_id, machine, label, archived, metadata, label_history, label_recorded_at FROM sessions`)).getRowObjectsJson();
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, unknown>;
    expect({ id: r.session_id, machine: r.machine, label: r.label, archived: r.archived }).toEqual({ id: SID2, machine: "host-a", label: "renamed-now", archived: false });
    expect(JSON.parse(String(r.metadata))).toEqual({ owner: "zed" });
    const history = JSON.parse(String(r.label_history)) as { at: string; label: string }[];
    expect(history.map((e) => e.label)).toEqual(["ORIGINAL-NAME", "renamed-now"]);
    expect(r.label_recorded_at).toBe(history[1]!.at);

    // 今の名前でも、前の名前 (履歴にしか無い) でも、metadata の値でも当たる。行は type = ccx.state
    for (const word of ["renamed-now", "original-name", "zed"]) {
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

  test("an empty store says so instead of a DuckDB IO error", async () => {
    await rm(join(root, "ccx"), { recursive: true, force: true });
    const r = await ccx("anything");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no transcripts yet");
  });
});
