import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DuckDBConnection } from "@duckdb/node-api";

import { normalizePrefix, S3_REGION, s3AccessKeyId, type TranscriptStore } from "@ccx/core";

import { httpfs, libduckdb, meta } from "./duckdb-assets.ts";

/**
 * 同梱した DuckDB を開き、保存先の transcript を `transcripts` / `history` view として、
 * session の宣言状態 (state.json。label / label の履歴 / metadata) を `sessions` view として見せる。
 *
 * `@duckdb/node-bindings` の duckdb.node は薄い shim で、隣にあるはずの libduckdb を
 * SONAME で dlopen する。単一バイナリの中には「隣」が無いので、先に同梱の実体を
 * cache に書き出して bun:ffi でロードしておく。以降 shim はロード済みの方を掴む
 * (Linux で実測)。macOS の shim は `@rpath/libduckdb.dylib` を dyld の rpath 探索で
 * 引くので、この形では届かない見込み (未実測、#125)。
 * httpfs 拡張も同じ場所に置いて絶対パスで LOAD する — 初回起動でネットに取りに
 * 行かない。cache は DuckDB の版と platform / arch で分ける (同じ版の x64 と arm64 の
 * バイナリが 1 人のホームを共有しても衝突しない)
 */
export type OpenOptions = {
  /** この session (id か先頭一致) だけを glob で絞る。保存先全体を読まない */
  session?: string;
  /** `history` view も作る (`--sql` 用。作ると history/ を全部読む) */
  withHistory?: boolean;
  /**
   * `transcripts` view も作る。作るときに標本のファイルを読んで型を推定するので、使う問い合わせのときだけ作る。
   * `{ sql }` なら、その SQL を DuckDB に bind させ、`transcripts` を表として引くときだけ作る (#325)。
   * 文字列の照合ではパスや文字列リテラルの中の語 (`s3://.../transcripts/...`) でも作ってしまう
   */
  withTranscripts?: boolean | { sql: string };
};

/**
 * DuckDB の memory_limit は read_json の型推定の分を数えない (union_by_name で 2GB を入れても 6 GB で OOM) ので、プロセスの RSS を見て
 * 越えたら失敗で抜ける。共有ホストを道連れにするより問い合わせが落ちるほうがよい (#300)。
 * 既定 6 GiB: d1 の保存先 (705 本 / 2.7 GB) でキーワード検索の cgroup のピークは 4.3 GB (2026-11-15)。
 * cgroup の MemoryMax がこれより小さいホストでは OOM が先に来るので、CCX_SEARCH_MAX_RSS_MB をその下に置く
 */
function guardRss() {
  const mib = Number(process.env.CCX_SEARCH_MAX_RSS_MB) || 6144;
  setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss <= mib * 1024 ** 2) return;
    console.error(`ccx: DuckDB grew to ${Math.round(rss / 1024 ** 2)} MiB, over ${mib} MiB; stopped before it takes the host down (raise CCX_SEARCH_MAX_RSS_MB to allow more)`);
    process.exit(1);
  }, 100).unref();
}

export async function openDuckDB(store: TranscriptStore, opts: OpenOptions = {}) {
  guardRss();
  const cache = join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "ccx",
    "duckdb",
    `${meta.version}-${process.platform}-${process.arch}`,
  );
  await mkdir(cache, { recursive: true });
  const lib = await materialize(libduckdb, join(cache, meta.lib));
  const ext = await materialize(httpfs, join(cache, "httpfs.duckdb_extension"));
  dlopen(lib, { duckdb_library_version: { args: [], returns: "cstring" } });

  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run(`LOAD '${ext.replaceAll("'", "''")}'`);
  // The external file cache keeps every byte read from the store in memory for a later read that a one-shot search
  // never makes. memory_limit (80% of RAM outside a cgroup) does not bound it before RSS passes guardRss: on d1 a keyword
  // search grew to 6.2 GB with it and 1.3-1.5 GB without (2026-11-17, #300). A --sql that scans the same files twice
  // (a self-join, `lines` with `transcripts`) now fetches them twice instead
  await c.run("SET enable_external_file_cache = false");

  const u = new URL(store.endpoint);
  // S3 の endpoint は host[:port] で、path は持てない (DuckDB は捨て、Bun.S3Client は bucket を path に置く)
  if (u.pathname !== "/" && u.pathname !== "") {
    throw new Error(`transcript endpoint ${store.endpoint} has a path; an S3 endpoint is scheme://host[:port] only`);
  }
  const endpoint = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  // SESSION_TOKEN '': 指定しないと DuckDB も env の AWS_SESSION_TOKEN を center に送る (#213)。
  // 利用者が保存した永続 secret (~/.duckdb/stored_secrets) は読まない: scope が s3://<bucket> なら
  // こちらより優先され、手元の本物の鍵で center に署名する
  await c.run("SET allow_persistent_secrets = false");
  await c.run(
    `CREATE SECRET store (TYPE s3, KEY_ID ${q(s3AccessKeyId(store))}, SECRET 'ccx', SESSION_TOKEN '', ` +
      `ENDPOINT ${q(endpoint)}, URL_STYLE 'path', USE_SSL ${u.protocol === "https:"}, REGION ${q(S3_REGION)})`,
  );
  const base = `s3://${store.bucket}/${normalizePrefix(store.prefix)}transcripts`;
  // session を渡されたら glob で絞る。read_json は glob に当たったファイルしか取りに行かない
  const sessionGlob = opts.session ? `session_id=${opts.session.replaceAll("*", "")}*` : "*";
  const files = `${base}/machine=*/user=*/${sessionGlob}/transcript.jsonl`;
  // machine / user / session_id come from the segments after `base`, never from the prefix (#171): hive_partitioning
  // takes the first `key=value` in the whole path, so no view reads the hive columns DuckDB adds on its own.
  // The regexp is tied to the file at the end of the path: a glob `*` stays within one segment, so the three
  // directories above the leaf are the ones after `base`, whatever DuckDB spells the prefix as in `filename`
  const PATH = "__ccx_path";
  const tail = (leaf: string) => (k: "machine" | "user" | "session_id") =>
    `regexp_extract(${PATH}, '/machine=([^/]+)/user=([^/]+)/session_id=([^/]+)/${leaf}$', ${["machine", "user", "session_id"].indexOf(k) + 1})`;
  const tPart = tail("transcript\\.jsonl");
  const cols = (part: (k: "machine" | "user" | "session_id") => string) =>
    `${part("session_id")} AS session_id, ${part("machine")} AS machine, ${part("user")} AS "user"`;
  const maxObject = "maximum_object_size=268435456";
  const reader = `filename=${q(PATH)}, ${maxObject}`;
  // maximum_object_size: tool の出力を抱えた行が 16 MB の既定を超える (手元の 26 本で最大 3.8 MB。上限は 256 MB)。
  // CREATE VIEW は作る時点で glob を解決するので、空の保存先ではここで止まる — 「壊れた」ではなく「まだ無い」と言う
  try {
    // `lines`: 1 行 = 1 レコードの生 JSON。文字列検索はこちらで行う。`transcripts` (構造化) は
    // 標本に出た全レコード種別のキーを持つ struct になり、to_json すると無いキーが
    // `"x":null` として全行に現れて、"null" や "model" がすべての行に当たる
    await c.run(
      `CREATE VIEW lines AS SELECT ${cols(tPart)}, json FROM read_json_objects(${q(files)}, format='newline_delimited', ${reader})`,
    );
  } catch (e) {
    if (/No files found/i.test(String(e))) throw new EmptyStore(opts.session ? `${base} for session ${opts.session}` : base);
    throw e;
  }
  // 宣言状態は印を付けた session にしか無い。read_text は glob に何も当たらなければ 0 行を返す (エラーにならない)。
  // read_json_objects ではなく read_text + json_valid: 壊れた state.json が 1 つあると read_json_objects は
  // クエリ全体を止め、既定の検索 (transcript も含む) が丸ごと落ちる。壊れたものはその 1 件だけ落とす。
  // archived は JSON の true だけを真にする (normalizeDeclared と同じ。"true" / 1 は偽)。キャストで全体を止めない。
  // read_text also auto-adds first-match hive columns; the inner SELECT keeps only filename and content, and the path
  // columns come from the same end-anchored regexp as the other views
  const states = `${base}/machine=*/user=*/${sessionGlob}/state.json`;
  await c.run(
    `CREATE VIEW sessions AS SELECT session_id, machine, "user", json->>'label' AS label, json->>'task' AS task, json->>'role' AS role,
       coalesce((json->'archived')::VARCHAR = 'true', false) AS archived, json->'metadata' AS metadata, json->'labelHistory' AS label_history,
       json->>'$.labelHistory[#-1].at' AS label_recorded_at, json
     FROM (SELECT ${cols(tail("state\\.json"))}, content::JSON AS json
           FROM (SELECT filename AS ${PATH}, content FROM read_text(${q(states)})) WHERE json_valid(content))`,
  );
  if (opts.withHistory) {
    // パスの machine / user は push した側で、操作した側はファイルの中にある。history は「誰が pull したか」
    // を答えるもので、押した側ではない。sessions と同じく read_text + json_valid: 壊れた 1 件 (と、JSON でも
    // object でないもの、op / machine / user / at のどれかが文字列でないもの。tr ls と同じ) がクエリ全体を止めず、その 1 件
    // だけ落ちる (#172)。glob が空なら 0 行
    const hist = `${base}/machine=*/user=*/${sessionGlob}/history/*.json`;
    const hPart = tail("history/[^/]+\\.json");
    await c.run(
      // `at` は DuckDB の予約語 (AT 句) なので列名は occurred_at
      `CREATE VIEW history AS SELECT session_id, json->>'op' AS op, json->>'machine' AS machine, json->>'user' AS "user", json->>'at' AS occurred_at, pushed_by_machine, pushed_by_user
       FROM (SELECT ${hPart("session_id")} AS session_id, ${hPart("machine")} AS pushed_by_machine, ${hPart("user")} AS pushed_by_user, content::JSON AS json
             FROM (SELECT filename AS ${PATH}, content FROM read_text(${q(hist)})) WHERE json_valid(content))
       WHERE ${["op", "machine", "user", "at"].map((k) => `json_type(json, '$.${k}') = 'VARCHAR'`).join(" AND ")}`,
    );
  }
  // Last, so the probe binds the query with every other view in place: a query reading `sessions` or `history` would
  // otherwise fail to bind on them with a Catalog Error and build this view for nothing
  if (opts.withTranscripts === true || (opts.withTranscripts && (await references(c, opts.withTranscripts.sql, "transcripts")))) {
    // The schema comes from the first 32 files in listing (path) order (up to sample_size records), not from every file:
    // on 1304 files, union_by_name
    // passed 3 GB within 5 seconds before the query ran and was still growing (2026-11-17, #300), and so did
    // maximum_sample_files over all files and json_group_structure over `lines`.
    // map_inference_threshold=-1 keeps objects structs, nested ones too: with the default, the records' many rare keys
    // turn the whole row into one MAP(VARCHAR, JSON) column
    const sampled = await c.runAndReadAll(
      `DESCRIBE SELECT * FROM read_json(${q(files)}, format='newline_delimited', maximum_sample_files=32, map_inference_threshold=-1, hive_partitioning=false, ${maxObject})`,
    );
    // The view reads with that schema stated. Inferred, read_json rejects a key the sample lacks once a query reads
    // the whole record (SELECT *); stated, a key only later files carry is left out, while a later value that does not
    // fit the sampled type still fails the query (JSON transform error). Such keys are read from `lines` with ->>.
    // No ignore_errors: it would drop those records from the result silently. Path order puts the earliest machines'
    // sessions in the sample and a new session rarely sorts into it, so a field only newer sessions carry can stay
    // absent for good
    const pairs = sampled.getRowObjects().map((r) => [String(r.column_name), String(r.column_type)] as const);
    // hive_partitioning=false here and in the view: a prefix may carry its own key=value segments, and their columns
    // would make an empty sample look like it has some and show up in the view (#171: no view reads hive columns).
    // A record's own session_id / machine / user is not stated: the view drops them for the path's values anyway
    const own = pairs.filter(([name]) => !["session_id", "machine", "user"].includes(name));
    // Sampled files with no records (a pushed session that never wrote one) yield the lone column `json JSON`; stated,
    // it would read every later record as NULL. Records holding only session_id / machine / user leave no column at
    // all, and an empty columns={} is a parser error
    if (own.length === 0 || (own.length === 1 && own[0]![0] === "json" && own[0]![1] === "JSON")) {
      throw new Error("the transcripts DuckDB samples first (up to 32, in path order) hold no record keys besides session_id / machine / user, so `transcripts` has no columns to infer; query `lines` (raw JSON) instead");
    }
    // Dates and times stay strings: inference may pick a non-ISO format (17-11-2026 as DATE) that a stated column does
    // not carry over, and the same value then fails the read. Cast them in the query (timestamp::TIMESTAMP)
    // Only outside double-quoted field names (a key may contain the word: "delivery DATE format"), and only in type
    // position: DuckDB leaves a key named DATE unquoted, and a name is followed by a space where a type is not
    const asText = (type: string) =>
      type
        .split(/("(?:[^"]|"")*")/)
        .map((part, i) => (i % 2 ? part : part.replace(/(?<=^|[ (,])(?:TIMESTAMP WITH TIME ZONE|TIMESTAMP|DATE|TIME)(?=$|[,)\[])/g, "VARCHAR")))
        .join("");
    const schema = own.map(([name, type]) => `${q(name)}: ${q(asText(type))}`);
    await c.run(
      // A record's own top-level session_id / machine / user is dropped so the path values keep these names, as
      // hive_partitioning did. COLUMNS rather than EXCLUDE: EXCLUDE fails on a missing column, and neither the stated
      // schema nor the read (hive off) carries these three.
      // The path columns stay in hive_partitioning's (alphabetical) order
      `CREATE VIEW transcripts AS SELECT COLUMNS(lambda c: c NOT IN ('session_id', 'machine', 'user', ${q(PATH)})),
         ${tPart("machine")} AS machine, ${tPart("session_id")} AS session_id, ${tPart("user")} AS "user"
       FROM read_json(${q(files)}, format='newline_delimited', columns={${schema.join(", ")}}, hive_partitioning=false, ${reader})`,
    );
  }
  return c;
}

/**
 * Whether `sql` reads the table `name`: binding fails for want of it only when the query reads it as a table, not for a
 * path or a string literal holding the word. Binding runs nothing. Any Catalog Error counts as reading it, as the word
 * did before: a table an earlier statement creates (not run yet) stops the binder before it reaches this one, and a
 * qualified or quoted name, PREPARE, DESCRIBE, query() and DROP / ALTER VIEW all report it as one. A Binder Error (a
 * column, an unknown prepared statement in `EXECUTE p` whose PREPARE has not run) means no table was missing, so the
 * next statement is checked. A query DuckDB cannot parse throws its parser error here.
 * Out of scope: a name an earlier statement computes (`SET VARIABLE t = 'transcripts'; ... query_table(getvariable('t'))`)
 * binds as NULL, a Binder Error, so the view is not built and the run fails with "Table with name transcripts does not exist"
 */
async function references(c: DuckDBConnection, sql: string, name: string) {
  // Without the word the query cannot read the table, and the probe's bind costs a glob of the store (about 0.5 s on d1, 1433 transcripts)
  if (!new RegExp(`\\b${name}\\b`, "i").test(sql)) return false;

  const statements = await c.extractStatements(sql);
  for (let i = 0; i < statements.count; i++) {
    try {
      (await statements.prepare(i)).destroySync();
    } catch (e) {
      if (String(e).includes("Catalog Error")) return true;
    }
  }
  return false;
}

export class EmptyStore extends Error {
  constructor(base: string) {
    super(`the store has no transcripts yet (nothing under ${base}); push one first`);
    this.name = "EmptyStore";
  }
}

/**
 * 埋め込まれた asset を cache に写す。大きさが同じなら写さない (70 MB)。
 * 隣に書いてから rename する: 同時に走った 2 本目が、書きかけの 1 本目を dlopen しない
 */
async function materialize(asset: string, dest: string): Promise<string> {
  const src = Bun.file(asset);
  const have = await stat(dest).catch(() => null);
  if (have && have.size === src.size) return dest;
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await Bun.write(tmp, src);
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true });
  }
  return dest;
}
