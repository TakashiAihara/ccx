/**
 * `scripts/duckdb-assets.ts` が `.build/duckdb/` に用意したものを asset として抱える。
 * `bun build --compile` はこれを単一バイナリに埋め、`bun run` ではディスクのパスになる。
 * どちらでも import の結果はパス文字列。(`export ... from` に import attribute は付けられない)
 */
import httpfs from "../../../.build/duckdb/httpfs.duckdb_extension" with { type: "file" };
import libduckdb from "../../../.build/duckdb/libduckdb" with { type: "file" };
import meta from "../../../.build/duckdb/meta.json";

export { httpfs, libduckdb, meta };
