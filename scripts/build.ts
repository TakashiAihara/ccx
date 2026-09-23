#!/usr/bin/env bun
/**
 * `ccx` の単一バイナリを作る。
 *
 *   1. scripts/duckdb-assets.ts で target の libduckdb / httpfs を `.build/duckdb/` に揃える
 *   2. bun build --compile。DuckDB の bindings は target の platform の 1 つだけを埋め、
 *      他 platform の `@duckdb/node-bindings-*` は external にする (bundler は
 *      `require('@duckdb/node-bindings-<p>/duckdb.node')` の分岐を全部解決しようとし、
 *      入っていない platform で止まる)
 *   3. 別 target を作ったあとは host の asset に戻す。`.build/duckdb` は 1 枠しか無く、
 *      戻さないと次の `bun test` が別 OS の lib を dlopen する
 *
 * 使い方: bun run scripts/build.ts [--target bun-linux-x64] [--outfile ccx] [--ccx-version 0.1.1-rc.1]
 *
 * --ccx-version は `ccx --version` と ccx.json の ccxVersion に出る版。release が tag から渡す。
 * 省くと apps/cli/package.json の版
 */

import { join } from "node:path";

import { ALL_BINDINGS, TARGETS, hostTarget, prepare } from "./duckdb-assets.ts";

const ROOT = join(import.meta.dir, "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const host = hostTarget();
const target = arg("--target") ?? host;
const outfile = arg("--outfile") ?? "ccx";
const version = arg("--ccx-version");
const define = version ? ["--define", `CCX_BUILD_VERSION=${JSON.stringify(version)}`] : [];

await prepare(target);

const keep = `@duckdb/${TARGETS[target]!.pkg}`;
const externals = ALL_BINDINGS.filter((p) => p !== keep).flatMap((p) => ["--external", p]);

const build = Bun.spawn(
  ["bun", "build", join(ROOT, "apps", "cli", "src", "index.ts"), "--compile", "--target", target, "--outfile", outfile, ...define, ...externals],
  { stdout: "inherit", stderr: "inherit", cwd: ROOT },
);
const code = await build.exited;
if (target !== host) await prepare(host);
process.exit(code);
