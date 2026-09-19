#!/usr/bin/env bun
/**
 * `ccx` の単一バイナリを作る。
 *
 *   1. scripts/duckdb-assets.ts で target の libduckdb / httpfs を `.build/duckdb/` に揃える
 *   2. bun build --compile。DuckDB の bindings は target の platform の 1 つだけを埋め、
 *      他 platform の `@duckdb/node-bindings-*` は external にする (bundler は
 *      `require('@duckdb/node-bindings-<p>/duckdb.node')` の分岐を全部解決しようとし、
 *      入っていない platform で止まる)
 *
 * 使い方: bun run scripts/build.ts [--target bun-linux-x64] [--outfile ccx]
 */

import { join } from "node:path";

import { hostTarget, prepare } from "./duckdb-assets.ts";

const ROOT = join(import.meta.dir, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const target = arg("--target") ?? hostTarget();
const outfile = arg("--outfile") ?? "ccx";

await prepare(target);

const ALL = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl", "win32-arm64", "win32-x64"];
const keep = target.replace(/^bun-/, "");
const externals = ALL.filter((p) => p !== keep).flatMap((p) => ["--external", `@duckdb/node-bindings-${p}`]);

const build = Bun.spawn(
  ["bun", "build", join(ROOT, "apps", "cli", "src", "index.ts"), "--compile", "--target", target, "--outfile", outfile, ...externals],
  { stdout: "inherit", stderr: "inherit", cwd: ROOT },
);
process.exit(await build.exited);
