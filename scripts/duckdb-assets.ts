#!/usr/bin/env bun
/**
 * `ccx transcript search` が同梱する DuckDB の実体を `.build/duckdb/` に揃える。
 *
 *   libduckdb                 @duckdb/node-bindings-<platform> の共有ライブラリ
 *   httpfs.duckdb_extension   S3 を読む拡張 (extensions.duckdb.org から、版と platform を合わせて)
 *   meta.json                 version / platform / target
 *
 * `apps/cli/src/duckdb-assets.ts` がこの 3 つを固定パスで asset として import するので、
 * `bun run` でも `bun build --compile` でもここが無いと動かない。`bun install` の
 * postinstall と、release の build 前に走る。
 *
 * 別 target (release の cross build) では、その platform の bindings を npm から取って
 * apps/cli/node_modules に置く。bundler が `require('@duckdb/node-bindings-<p>/duckdb.node')`
 * を解決できるのはそこだけなので。
 *
 * 使い方: bun run scripts/duckdb-assets.ts [--target bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64]
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, ".build", "duckdb");
const CLI_MODULES = join(ROOT, "apps", "cli", "node_modules");

type Target = { pkg: string; platform: string; lib: string };
const TARGETS: Record<string, Target> = {
  "bun-linux-x64": { pkg: "node-bindings-linux-x64", platform: "linux_amd64", lib: "libduckdb.so" },
  "bun-linux-arm64": { pkg: "node-bindings-linux-arm64", platform: "linux_arm64", lib: "libduckdb.so" },
  "bun-darwin-x64": { pkg: "node-bindings-darwin-x64", platform: "osx_amd64", lib: "libduckdb.dylib" },
  "bun-darwin-arm64": { pkg: "node-bindings-darwin-arm64", platform: "osx_arm64", lib: "libduckdb.dylib" },
};

export function hostTarget(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${os}-${arch}`;
}

const argTarget = process.argv.indexOf("--target");
const target = argTarget !== -1 ? process.argv[argTarget + 1]! : hostTarget();
const t = TARGETS[target];
if (!t) {
  console.error(`unknown target ${target}; one of ${Object.keys(TARGETS).join(", ")}`);
  process.exit(2);
}

// node-bindings は node-api の依存で、cli から直接は見えない (isolated install)。
// node-api の場所から辿る。bindings の版 = DuckDB の版 + "-r.N"
const CLI = join(ROOT, "apps", "cli");
const nodeApiDir = join(Bun.resolveSync("@duckdb/node-api", CLI), "..", "..");
const bindingsPkg = JSON.parse(
  await Bun.file(Bun.resolveSync("@duckdb/node-bindings/package.json", nodeApiDir)).text(),
) as { version: string };
const fullVersion = bindingsPkg.version;
const duckdbVersion = fullVersion.replace(/-r\.\d+$/, "");

/** bindings パッケージのディレクトリ。無ければ npm から取って apps/cli/node_modules に置く */
async function bindingsDir(): Promise<string> {
  const spec = `@duckdb/${t.pkg}/package.json`;
  for (const from of [nodeApiDir, CLI]) {
    try {
      return join(Bun.resolveSync(spec, from), "..");
    } catch {
      /* 次 */
    }
  }
  {
    /* この platform の分は入っていない */
  }
  const dest = join(CLI_MODULES, "@duckdb", t.pkg);
  const url = `https://registry.npmjs.org/@duckdb/${t.pkg}/-/${t.pkg}-${fullVersion}.tgz`;
  console.error(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const tgz = join(OUT, `${t.pkg}.tgz`);
  await mkdir(OUT, { recursive: true });
  await Bun.write(tgz, res);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const untar = Bun.spawn(["tar", "-xzf", tgz, "-C", dest, "--strip-components=1"], { stdout: "inherit", stderr: "inherit" });
  if ((await untar.exited) !== 0) throw new Error("tar failed");
  await rm(tgz, { force: true });
  return dest;
}

await mkdir(OUT, { recursive: true });
const dir = await bindingsDir();
await Bun.write(join(OUT, "libduckdb"), Bun.file(join(dir, t.lib)));

const extUrl = `https://extensions.duckdb.org/v${duckdbVersion}/${t.platform}/httpfs.duckdb_extension.gz`;
const extPath = join(OUT, "httpfs.duckdb_extension");
const meta = { version: duckdbVersion, platform: t.platform, target };
const prev = await Bun.file(join(OUT, "meta.json")).json().catch(() => null);
const have = await stat(extPath).then((s) => s.size > 0).catch(() => false);
if (!have || !prev || prev.version !== meta.version || prev.platform !== meta.platform) {
  console.error(`fetching ${extUrl}`);
  const res = await fetch(extUrl);
  if (!res.ok) throw new Error(`${extUrl}: ${res.status} (is DuckDB ${duckdbVersion} published for ${t.platform}?)`);
  await Bun.write(extPath, Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
}
await Bun.write(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
console.error(`duckdb ${duckdbVersion} ${t.platform} ready in ${OUT} (bindings: ${dir})`);
