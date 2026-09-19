#!/usr/bin/env bun
/**
 * `ccx transcript search` が同梱する DuckDB の実体を `.build/duckdb/` に揃える。
 *
 *   libduckdb                 @duckdb/node-bindings-<platform> の共有ライブラリ
 *   httpfs.duckdb_extension   S3 を読む拡張 (extensions.duckdb.org から、版と platform を合わせて)
 *   meta.json                 version / platform / target / lib (元のファイル名)
 *
 * `apps/cli/src/duckdb-assets.ts` がこの 3 つを固定パスで asset として import するので、
 * `bun run` でも `bun build --compile` でもここが無いと動かない。`bun install` の
 * postinstall と、release の build 前 (scripts/build.ts) に走る。
 *
 * 別 target (release の cross build) では、その platform の bindings を npm から取って
 * `@duckdb/node-bindings` の隣に置く。bundler が `require('@duckdb/node-bindings-<p>/duckdb.node')`
 * を解決するのは node-bindings のいる場所から上に向かってで、isolated install では
 * それは node_modules/.bun/<pkg>/node_modules/@duckdb/ になる。
 *
 * 使い方: bun run scripts/duckdb-assets.ts [--target bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64]
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, ".build", "duckdb");
const CLI = join(ROOT, "apps", "cli");

type Target = { pkg: string; platform: string; lib: string };
export const TARGETS: Record<string, Target> = {
  "bun-linux-x64": { pkg: "node-bindings-linux-x64", platform: "linux_amd64", lib: "libduckdb.so" },
  "bun-linux-arm64": { pkg: "node-bindings-linux-arm64", platform: "linux_arm64", lib: "libduckdb.so" },
  "bun-darwin-x64": { pkg: "node-bindings-darwin-x64", platform: "osx_amd64", lib: "libduckdb.dylib" },
  "bun-darwin-arm64": { pkg: "node-bindings-darwin-arm64", platform: "osx_arm64", lib: "libduckdb.dylib" },
};

/** この host の target。Windows は対応 platform に無いので、Linux の asset を黙って用意せず止まる */
export function hostTarget(): string {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`ccx transcript search has no DuckDB assets for ${process.platform}; supported: ${Object.keys(TARGETS).join(", ")}`);
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${process.platform}-${arch}`;
}

async function fetchTo(url: string, path: string, transform?: (b: Uint8Array) => Uint8Array): Promise<void> {
  console.error(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  await Bun.write(path, transform ? transform(body) : body);
}

export async function prepare(target: string): Promise<void> {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(", ")}`);

  // node-bindings は node-api の依存で、cli から直接は見えない (isolated install)。
  // node-api の場所から辿る。bindings の版 = DuckDB の版 + "-r.N"
  const nodeApiDir = join(Bun.resolveSync("@duckdb/node-api", CLI), "..", "..");
  const bindingsHome = join(Bun.resolveSync("@duckdb/node-bindings/package.json", nodeApiDir), "..", "..");
  const fullVersion = (JSON.parse(await Bun.file(join(bindingsHome, "node-bindings", "package.json")).text()) as { version: string }).version;
  const duckdbVersion = fullVersion.replace(/-r\.\d+$/, "");

  await mkdir(OUT, { recursive: true });

  // bindings パッケージ: 入っていればそれ、無ければ npm から node-bindings の隣へ
  let dir = join(bindingsHome, t.pkg);
  if (!(await Bun.file(join(dir, t.lib)).exists())) {
    const tgz = join(OUT, `${t.pkg}.tgz`);
    await fetchTo(`https://registry.npmjs.org/@duckdb/${t.pkg}/-/${t.pkg}-${fullVersion}.tgz`, tgz);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const untar = Bun.spawn(["tar", "-xzf", tgz, "-C", dir, "--strip-components=1"], { stdout: "inherit", stderr: "inherit" });
    if ((await untar.exited) !== 0) throw new Error("tar failed");
    await rm(tgz, { force: true });
  }
  await Bun.write(join(OUT, "libduckdb"), Bun.file(join(dir, t.lib)));

  const meta = { version: duckdbVersion, platform: t.platform, target, lib: t.lib };
  const extPath = join(OUT, "httpfs.duckdb_extension");
  const prev = (await Bun.file(join(OUT, "meta.json")).json().catch(() => null)) as typeof meta | null;
  const have = await stat(extPath).then((s) => s.size > 0).catch(() => false);
  if (!have || !prev || prev.version !== meta.version || prev.platform !== meta.platform) {
    const url = `https://extensions.duckdb.org/v${duckdbVersion}/${t.platform}/httpfs.duckdb_extension.gz`;
    await fetchTo(url, extPath, (b) => Bun.gunzipSync(b)).catch((e) => {
      throw new Error(`${e instanceof Error ? e.message : e} (is DuckDB ${duckdbVersion} published for ${t.platform}?)`);
    });
  }
  await Bun.write(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
  console.error(`duckdb ${duckdbVersion} ${t.platform} ready in ${OUT} (bindings: ${dir})`);
}

if (import.meta.main) {
  const i = process.argv.indexOf("--target");
  await prepare(i !== -1 ? process.argv[i + 1]! : hostTarget());
}
