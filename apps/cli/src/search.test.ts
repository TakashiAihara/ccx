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

import { encodeCwd, localTranscripts, TranscriptClient, type TranscriptStore } from "@ccx/core";

import { openDuckDB } from "./duckdb.ts";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
const SID2 = "1a2b3c4d-5e6f-4a70-8b9c-0d1e2f3a4b5c";

let server: ReturnType<typeof Bun.serve>;
let db: ReturnType<typeof openDb>;
let root: string;
let home: string;
let store: TranscriptStore;

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccx-search-"));
  home = await mkdtemp(join(tmpdir(), "ccx-search-home-"));
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
  const client = new TranscriptClient(store, { machine: "host-a", user: "alice" });
  for (const t of await localTranscripts(home)) await client.push(t);
});

/** 本物のコマンドを、この store を向けて走らせる */
async function ccx(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts"), "tr", "search", ...args], {
    env: { ...process.env, CCX_HUB_URL: store.endpoint, CCX_TRANSCRIPT_PREFIX: "pre", XDG_CONFIG_HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

afterEach(async () => {
  void server.stop(true);
  db.$client.close();
  await Promise.all([root, home].map((d) => rm(d, { recursive: true, force: true })));
});

describe("search: embedded DuckDB over the store", () => {
  test("transcripts view carries the hive columns and message fields; a present word hits, an absent one does not", async () => {
    const c = await openDuckDB(store);

    const rows = await c.runAndReadAll(`SELECT session_id, machine, "user", type FROM transcripts ORDER BY timestamp`);
    expect(rows.getRowObjectsJson()).toEqual([
      { session_id: SID, machine: "host-a", user: "alice", type: "user" },
      { session_id: SID, machine: "host-a", user: "alice", type: "assistant" },
      { session_id: SID2, machine: "host-a", user: "alice", type: "user" },
    ]);

    const model = await c.runAndReadAll(`SELECT message.model AS m, message.usage.output_tokens AS n FROM transcripts WHERE type = 'assistant'`);
    expect(model.getRowObjectsJson()).toEqual([{ m: "claude-opus-5", n: "7" }]);

    const hit = await c.runAndReadAll(`SELECT session_id FROM transcripts WHERE lower(to_json(message)::VARCHAR) LIKE '%needle-alpha%'`);
    expect(hit.getRowObjectsJson()).toEqual([{ session_id: SID }]);
    const miss = await c.runAndReadAll(`SELECT count(*) AS n FROM transcripts WHERE lower(to_json(message)::VARCHAR) LIKE '%needle-omega%'`);
    expect(miss.getRowObjectsJson()).toEqual([{ n: "0" }]);

    const history = await c.runAndReadAll(`SELECT session_id, op, machine FROM history ORDER BY session_id`);
    expect(history.getRowObjectsJson()).toEqual([
      { session_id: SID, op: "push", machine: "host-a" },
      { session_id: SID2, op: "push", machine: "host-a" },
    ]);
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
  });

  test("an empty store says so instead of a DuckDB IO error", async () => {
    await rm(join(root, "ccx"), { recursive: true, force: true });
    const r = await ccx("anything");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no transcripts yet");
  });
});
