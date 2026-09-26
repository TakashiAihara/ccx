import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizePrefix, s3AccessKeyId, type TranscriptStore } from "@ccx/core";

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
};

export async function openDuckDB(store: TranscriptStore, opts: OpenOptions = {}) {
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

  const u = new URL(store.endpoint);
  // S3 の endpoint は host[:port] で、path は持てない (DuckDB は捨て、Bun.S3Client は bucket を path に置く)
  if (u.pathname !== "/" && u.pathname !== "") {
    throw new Error(`transcript endpoint ${store.endpoint} has a path; an S3 endpoint is scheme://host[:port] only`);
  }
  const endpoint = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const env = process.env;
  const token = env.AWS_SESSION_TOKEN ?? env.S3_SESSION_TOKEN;
  await c.run(
    `CREATE SECRET store (TYPE s3, KEY_ID ${q(s3AccessKeyId(store, env))}, ` +
      `SECRET ${q(env.AWS_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY ?? "ccx")}, ` +
      (token ? `SESSION_TOKEN ${q(token)}, ` : "") +
      `ENDPOINT ${q(endpoint)}, URL_STYLE 'path', USE_SSL ${u.protocol === "https:"}, REGION ${q(store.region ?? "us-east-1")})`,
  );
  const base = `s3://${store.bucket}/${normalizePrefix(store.prefix)}transcripts`;
  // session を渡されたら glob で絞る。read_json は glob に当たったファイルしか取りに行かない
  const sessionGlob = opts.session ? `session_id=${opts.session.replaceAll("*", "")}*` : "*";
  const files = `${base}/machine=*/user=*/${sessionGlob}/transcript.jsonl`;
  // maximum_object_size: tool の出力を抱えた行が 16 MB の既定を超える (手元の 26 本で最大 3.8 MB。上限は 256 MB)。
  // CREATE VIEW は作る時点で glob を解決するので、空の保存先ではここで止まる — 「壊れた」ではなく「まだ無い」と言う
  try {
    // `lines`: 1 行 = 1 レコードの生 JSON。文字列検索はこちらで行う。`transcripts` (構造化) は
    // union_by_name で全レコード種別のキーを持つ struct になり、to_json すると無いキーが
    // `"x":null` として全行に現れて、"null" や "model" がすべての行に当たる
    await c.run(
      `CREATE VIEW lines AS SELECT session_id, machine, "user", json FROM read_json_objects(${q(files)}, format='newline_delimited', hive_partitioning=true, maximum_object_size=268435456)`,
    );
    await c.run(
      `CREATE VIEW transcripts AS SELECT * FROM read_json(${q(files)}, format='newline_delimited', union_by_name=true, hive_partitioning=true, maximum_object_size=268435456)`,
    );
  } catch (e) {
    if (/No files found/i.test(String(e))) throw new EmptyStore(opts.session ? `${base} for session ${opts.session}` : base);
    throw e;
  }
  // 宣言状態は印を付けた session にしか無い。無ければ空の view (transcript はあるので保存先は空ではない)
  const states = `${base}/machine=*/user=*/${sessionGlob}/state.json`;
  try {
    await c.run(
      `CREATE VIEW sessions AS SELECT session_id, machine, "user", json->>'label' AS label, json->>'task' AS task,
         (json->>'archived')::BOOLEAN AS archived, json->'metadata' AS metadata, json->'labelHistory' AS label_history,
         json->>'$.labelHistory[#-1].at' AS label_changed_at, json
       FROM read_json_objects(${q(states)}, format='auto', hive_partitioning=true)`,
    );
  } catch (e) {
    if (!/No files found/i.test(String(e))) throw e;
    await c.run(
      `CREATE VIEW sessions AS SELECT NULL::VARCHAR AS session_id, NULL::VARCHAR AS machine, NULL::VARCHAR AS "user", NULL::VARCHAR AS label, NULL::VARCHAR AS task,
         NULL::BOOLEAN AS archived, NULL::JSON AS metadata, NULL::JSON AS label_history, NULL::VARCHAR AS label_changed_at, NULL::JSON AS json WHERE false`,
    );
  }
  if (opts.withHistory) {
    // hive の machine / user (push した側) がファイルの machine / user (操作した側) を隠すので、
    // 生 JSON から取り直す。history は「誰が pull したか」を答えるもので、押した側ではない
    const hist = `${base}/machine=*/user=*/${sessionGlob}/history/*.json`;
    try {
      await c.run(
        // `at` は DuckDB の予約語 (AT 句) なので列名は occurred_at
        `CREATE VIEW history AS SELECT session_id, json->>'op' AS op, json->>'machine' AS machine, json->>'user' AS "user", json->>'at' AS occurred_at, machine AS pushed_by_machine, "user" AS pushed_by_user FROM read_json_objects(${q(hist)}, format='newline_delimited', hive_partitioning=true)`,
      );
    } catch (e) {
      if (!/No files found/i.test(String(e))) throw e;
      await c.run(
        `CREATE VIEW history AS SELECT NULL::VARCHAR AS session_id, NULL::VARCHAR AS op, NULL::VARCHAR AS machine, NULL::VARCHAR AS "user", NULL::VARCHAR AS occurred_at, NULL::VARCHAR AS pushed_by_machine, NULL::VARCHAR AS pushed_by_user WHERE false`,
      );
    }
  }
  return c;
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
