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
/** ビルドできる target。key は bun の --target */
export const TARGETS: Record<string, Target> = {
  "bun-linux-x64": { pkg: "node-bindings-linux-x64", platform: "linux_amd64", lib: "libduckdb.so" },
  "bun-linux-arm64": { pkg: "node-bindings-linux-arm64", platform: "linux_arm64", lib: "libduckdb.so" },
  "bun-darwin-x64": { pkg: "node-bindings-darwin-x64", platform: "osx_amd64", lib: "libduckdb.dylib" },
  "bun-darwin-arm64": { pkg: "node-bindings-darwin-arm64", platform: "osx_arm64", lib: "libduckdb.dylib" },
};
/** `@duckdb/node-bindings` が require しうる platform 全部。ビルドしない分は external にする */
export const ALL_BINDINGS = [
  ...Object.values(TARGETS).map((t) => `@duckdb/${t.pkg}`),
  "@duckdb/node-bindings-linux-x64-musl",
  "@duckdb/node-bindings-linux-arm64-musl",
  "@duckdb/node-bindings-win32-x64",
  "@duckdb/node-bindings-win32-arm64",
];

/** この host の target。Windows は対応 platform に無いので、Linux の asset を黙って用意せず止まる */
export function hostTarget(): string {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`ccx transcript search has no DuckDB assets for ${process.platform}; supported: ${Object.keys(TARGETS).join(", ")}`);
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${process.platform}-${arch}`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  console.error(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** npm の tarball は registry が出す dist.integrity (sha512) と突き合わせてから展開する。release がこの経路を通る */
async function fetchNpmTarball(pkg: string, version: string, dest: string): Promise<void> {
  const metaUrl = `https://registry.npmjs.org/${pkg}/${version}`;
  const dist = (JSON.parse(new TextDecoder().decode(await fetchBytes(metaUrl))) as { dist: { tarball: string; integrity: string } }).dist;
  const body = await fetchBytes(dist.tarball);
  const [algo, expected] = dist.integrity.split("-", 2);
  if (algo !== "sha512" || !expected) throw new Error(`${pkg}: unexpected integrity ${dist.integrity}`);
  const actual = new Bun.CryptoHasher("sha512").update(body).digest("base64");
  if (actual !== expected) throw new Error(`${pkg}@${version}: tarball sha512 ${actual} != registry ${expected}`);
  await Bun.write(dest, body);
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
    await fetchNpmTarball(`@duckdb/${t.pkg}`, fullVersion, tgz);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const untar = Bun.spawn(["tar", "-xzf", tgz, "-C", dir, "--strip-components=1"], { stdout: "inherit", stderr: "inherit" });
    if ((await untar.exited) !== 0) throw new Error("tar failed");
    await rm(tgz, { force: true });
  }
  const meta = { version: duckdbVersion, platform: t.platform, target, lib: t.lib };
  const prev = (await Bun.file(join(OUT, "meta.json")).json().catch(() => null)) as typeof meta | null;
  const same = prev?.version === meta.version && prev?.platform === meta.platform;

  // 67 MB のコピーは、同じ版・同じ platform で既にあれば飛ばす (postinstall のたびに書かない)
  const libSrc = Bun.file(join(dir, t.lib));
  const libSize = await stat(join(OUT, "libduckdb")).then((s) => s.size).catch(() => -1);
  if (!same || libSize !== libSrc.size) await Bun.write(join(OUT, "libduckdb"), libSrc);

  const extPath = join(OUT, "httpfs.duckdb_extension");
  const have = await stat(extPath).then((s) => s.size > 0).catch(() => false);
  if (!have || !same) {
    const url = `https://extensions.duckdb.org/v${duckdbVersion}/${t.platform}/httpfs.duckdb_extension.gz`;
    // 拡張の検証は LOAD 時の署名検査が担う (DuckDB の core 拡張は署名付き)
    const gz = await fetchBytes(url).catch((e) => {
      throw new Error(`${e instanceof Error ? e.message : e} (is DuckDB ${duckdbVersion} published for ${t.platform}?)`);
    });
    await Bun.write(extPath, Bun.gunzipSync(gz));
  }
  await Bun.write(join(OUT, "meta.json"), JSON.stringify(meta, null, 2));
  console.error(`duckdb ${duckdbVersion} ${t.platform} ready in ${OUT} (bindings: ${dir})`);
}

if (import.meta.main) {
  const i = process.argv.indexOf("--target");
  await prepare(i !== -1 ? process.argv[i + 1]! : hostTarget());
}
