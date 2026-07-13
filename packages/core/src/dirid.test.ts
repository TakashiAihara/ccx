import { describe, expect, test } from "bun:test";

import { DIR_ID_LENGTH, dirIdToDate, encodeBase32, isDirId, newDirId } from "./dirid.ts";

describe("dir-id", () => {
  test("14 文字の Crockford base32 になる", () => {
    const id = newDirId();
    expect(id).toHaveLength(DIR_ID_LENGTH);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{14}$/);
    expect(isDirId(id)).toBe(true);
  });

  test("同一ミリ秒内に大量生成しても衝突しない (Bun の uuidv7 は rand_a を単調増加カウンタにする)", () => {
    const ids = Array.from({ length: 10_000 }, () => newDirId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("辞書順が生成順と一致する (時刻順ソート可能)", () => {
    const ids = Array.from({ length: 500 }, () => newDirId());
    expect(ids).toEqual([...ids].sort());
  });

  test("dir-id から生成時刻を復元できる", () => {
    const before = Date.now();
    const at = dirIdToDate(newDirId()).getTime();
    const after = Date.now();

    expect(at).toBeGreaterThanOrEqual(before - 1);
    expect(at).toBeLessThanOrEqual(after + 1);
  });

  test("uuidv7 を 26 文字の base32 に符号化する", () => {
    // 既知ベクタ: 上位 48 bit が timestamp
    expect(encodeBase32("019f5b0c-9adb-7000-9d6f-54a89fb84922")).toHaveLength(26);
    expect(encodeBase32("00000000-0000-7000-8000-000000000000")).toMatch(/^0{10}/);
  });

  test("不正な dir-id を弾く", () => {
    expect(isDirId("short")).toBe(false);
    expect(isDirId("01KXDGS6PVE00U")).toBe(false); // U は Crockford に無い
    expect(() => dirIdToDate("nope")).toThrow();
  });
});
