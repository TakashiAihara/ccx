// `with { type: "file" }` で import する asset はパス文字列になる (Bun)。tsc にその型を教える
declare module "*/.build/duckdb/libduckdb" {
  const path: string;
  export default path;
}
declare module "*.duckdb_extension" {
  const path: string;
  export default path;
}
declare module "*/.build/duckdb/meta.json" {
  const meta: { version: string; platform: string; target: string; lib: string };
  export default meta;
}
