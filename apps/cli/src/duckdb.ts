import { dlopen } from "bun:ffi";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TranscriptStore } from "@ccx/core";

import { httpfs, libduckdb, meta } from "./duckdb-assets.ts";

/**
 * 同梱した DuckDB を開き、保存先の transcript を `transcripts` / `history` view として見せる。
 *
 * `@duckdb/node-bindings` の duckdb.node は薄い shim で、隣にあるはずの libduckdb を
 * SONAME で dlopen する。単一バイナリの中には「隣」が無いので、先に同梱の実体を
 * cache に書き出して bun:ffi でロードしておく。以降 shim はロード済みの方を掴む
 * (Linux で実測。macOS の dyld は install name で解決するので同じ形が効く見込みだが未実測)。
 * httpfs 拡張も同じ場所に置いて絶対パスで LOAD する — 初回起動でネットに取りに
 * 行かない
 */
export async function openDuckDB(store: TranscriptStore) {
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ccx", "duckdb", meta.version);
  await mkdir(cache, { recursive: true });
  const lib = await materialize(libduckdb, join(cache, "libduckdb"));
  const ext = await materialize(httpfs, join(cache, "httpfs.duckdb_extension"));
  dlopen(lib, { duckdb_library_version: { args: [], returns: "cstring" } });

  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run(`LOAD '${ext.replaceAll("'", "''")}'`);

  const u = new URL(store.endpoint);
  const endpoint = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  await c.run(
    `CREATE SECRET store (TYPE s3, KEY_ID ${q(process.env.AWS_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID ?? "ccx")}, ` +
      `SECRET ${q(process.env.AWS_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY ?? "ccx")}, ` +
      `ENDPOINT ${q(endpoint)}, URL_STYLE 'path', USE_SSL ${u.protocol === "https:"}, REGION ${q(store.region ?? "us-east-1")})`,
  );
  const base = `s3://${store.bucket}/${store.prefix}transcripts`;
  // union_by_name: レコード種別ごとにキーが違う。maximum_object_size: tool の出力を抱えた行が 16 MB の既定を超える
  await c.run(
    `CREATE VIEW transcripts AS SELECT * FROM read_json(${q(`${base}/**/transcript.jsonl`)}, format='newline_delimited', union_by_name=true, hive_partitioning=true, maximum_object_size=268435456)`,
  );
  await c.run(
    `CREATE VIEW history AS SELECT * FROM read_json(${q(`${base}/**/history/*.json`)}, format='newline_delimited', union_by_name=true, hive_partitioning=true)`,
  );
  return c;
}

/** 埋め込まれた asset を cache に写す。大きさが同じなら写さない (70 MB) */
async function materialize(asset: string, dest: string): Promise<string> {
  const src = Bun.file(asset);
  const size = src.size;
  const have = await stat(dest).catch(() => null);
  if (!have || have.size !== size) await Bun.write(dest, src);
  return dest;
}
