/**
 * dir-id: UUIDv7 の 128 bit を Crockford base32 に符号化し、先頭 14 文字を採る。
 *
 * 上位 48 bit が ms 精度の timestamp なので、base32 プレフィックスの辞書順が
 * 生成順と一致する。created は dir 名から復元できる。
 *
 * 注意: dir-id はマシン内でしか一意でない。Bun の UUIDv7 は rand_a を ms ごとに
 * 0 から始まる単調増加カウンタとして使うため、2 台のマシンが同じ ms に最初の 1 個を
 * 生成すると 14 文字プレフィックスが一致する。大域キーには machine + path を使うこと。
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const DIR_ID_LENGTH = 14;

/** UUIDv7 (36 文字ハイフン付き) を Crockford base32 26 文字に符号化する。 */
export function encodeBase32(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`not a uuid: ${uuid}`);

  let bits = 0n;
  for (let i = 0; i < 32; i += 2) {
    bits = (bits << 8n) | BigInt(Number.parseInt(hex.slice(i, i + 2), 16));
  }

  let out = "";
  // 128 bit を 5 bit ずつ、上位から 26 桁 (130 bit ぶんの枠に左詰め相当) 読み出す
  for (let i = 25; i >= 0; i--) {
    out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

/** dir-id を 1 つ生成する。 */
export function newDirId(): string {
  return encodeBase32(Bun.randomUUIDv7()).slice(0, DIR_ID_LENGTH);
}

export function isDirId(s: string): boolean {
  return s.length === DIR_ID_LENGTH && [...s].every((c) => CROCKFORD.includes(c));
}

/**
 * dir-id から生成時刻を復元する。UUIDv7 の上位 48 bit = unix ms。
 *
 * 26 文字符号は 128 bit を 130 bit 枠に右詰めしたもの。よって dir-id (先頭 14 文字 =
 * 70 bit) は元の bit 129..60 に対応し、timestamp は元の bit 127..80 にある。
 * つまり 70 bit から下位 20 bit を落とすと timestamp が残る。
 */
export function dirIdToDate(dirId: string): Date {
  if (!isDirId(dirId)) throw new Error(`not a dir-id: ${dirId}`);

  let bits = 0n;
  for (const c of dirId) {
    bits = (bits << 5n) | BigInt(CROCKFORD.indexOf(c));
  }
  return new Date(Number(bits >> 20n));
}
