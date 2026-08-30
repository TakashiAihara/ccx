/** epoch ミリ秒からの経過を「今から見てどれくらい前か」で表す。 */
export function humanSince(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * 列を揃えて 1 行にする。空の表を渡されたら空配列を返す (Math.max(...[]) が
 * -Infinity になるのを踏まない)。
 */
export function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const width = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(width[i]!)))
      .join("  ")
      .trimEnd(),
  );
}

/** 8-4-4-4-12。Claude Code の session id はこの形。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * session id を短く出す。UUID の先頭 8 文字は実用上ぶつからない。
 *
 * 縮めるのは UUID だと確かめられたときだけ。「ハイフンを含む長い文字列」で判定
 * すると、UUID でない id (テスト用の名前など) まで切られて別物になる。全体が要る
 * ときは --json を使う。
 */
export function shortId(id: string): string {
  return UUID.test(id) ? id.slice(0, 8) : id;
}
