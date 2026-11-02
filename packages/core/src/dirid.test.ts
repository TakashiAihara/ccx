import { describe, expect, test } from "bun:test";

import { createDirIdMinter, DIR_ID_LENGTH, dirIdToDate, isDirId, newDirId } from "./dirid.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The low 20 bits of a dir-id (the part below the timestamp). */
function randomPart(id: string): number {
  let bits = 0n;
  for (const c of id) bits = (bits << 5n) | BigInt(CROCKFORD.indexOf(c));
  return Number(bits & 0xfffffn);
}

describe("dir-id", () => {
  test("is 14 Crockford base32 characters", () => {
    const id = newDirId();
    expect(id).toHaveLength(DIR_ID_LENGTH);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{14}$/);
    expect(isDirId(id)).toBe(true);
  });

  test("ids minted in bulk by one process do not collide", () => {
    const ids = Array.from({ length: 10_000 }, () => newDirId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("lexical order follows minting order", () => {
    const ids = Array.from({ length: 500 }, () => newDirId());
    expect(ids).toEqual([...ids].sort());
  });

  test("the creation time is recovered from the dir-id", () => {
    const before = Date.now();
    const at = dirIdToDate(newDirId()).getTime();
    const after = Date.now();

    expect(at).toBeGreaterThanOrEqual(before - 1);
    expect(at).toBeLessThanOrEqual(after + 1);
  });

  test("encodes the timestamp above the 20 random bits", () => {
    const mint = createDirIdMinter(() => 0x0123456789ab, () => 0xabcde);
    expect(mint()).toBe("014D2PF2DBNF6Y");
    expect(dirIdToDate("014D2PF2DBNF6Y").getTime()).toBe(0x0123456789ab);
  });

  test("the creation time of a dir-id minted before #75 (UUIDv7 prefix) is still recovered", () => {
    expect(dirIdToDate("01KXDXSV3SE009").toISOString()).toBe("2026-07-13T14:23:52.953Z");
  });

  test("rejects malformed dir-ids", () => {
    expect(isDirId("short")).toBe(false);
    // U is not in the Crockford alphabet
    expect(isDirId("01KXDGS6PVE00U")).toBe(false);
    expect(() => dirIdToDate("nope")).toThrow("not a dir-id");
  });
});

describe("dir-id across processes (#75)", () => {
  test("fresh generators in the same millisecond almost never share an id", () => {
    // each fresh generator stands for a separate `ccx rd new` process starting in the same millisecond
    const ids = Array.from({ length: 1000 }, () => createDirIdMinter(() => 1_783_952_632_953)());

    // with 20 random bits about 0.5 collisions are expected among 1000; 2 random bits (or a counter that starts
    // at the same value in every process) would collide on nearly every id
    expect(new Set(ids).size).toBeGreaterThanOrEqual(990);
    expect(new Set(ids.map(dirIdToDate).map((d) => d.getTime()))).toEqual(new Set([1_783_952_632_953]));
  });
});

describe("dir-id within one process", () => {
  test("further ids in the same millisecond step the random part up by one", () => {
    const mint = createDirIdMinter(() => 5000, () => 0x12345);
    expect([mint(), mint(), mint()].map(randomPart)).toEqual([0x12345, 0x12346, 0x12347]);
  });

  test("a new millisecond draws a fresh random part", () => {
    const times = [5000, 5001];
    const randoms = [0x70000, 0x00303];
    const mint = createDirIdMinter(() => times.shift()!, () => randoms.shift()!);

    const first = mint();
    const second = mint();
    expect(randomPart(second)).toBe(0x00303);
    expect(dirIdToDate(second).getTime()).toBe(5001);
    expect(second > first).toBe(true);
  });

  test("a clock that steps back keeps the previous millisecond and still moves forward", () => {
    const times = [5000, 4990];
    const mint = createDirIdMinter(() => times.shift()!, () => 0x00777);

    const first = mint();
    const second = mint();
    expect(dirIdToDate(second).getTime()).toBe(5000);
    expect(randomPart(second)).toBe(0x00778);
    expect(second > first).toBe(true);
  });

  test("running out of random values within one millisecond carries into the next millisecond", () => {
    const randoms = [0xfffff, 0x00042];
    const mint = createDirIdMinter(() => 5000, () => randoms.shift()!);

    const first = mint();
    const second = mint();
    expect(randomPart(first)).toBe(0xfffff);
    expect(dirIdToDate(second).getTime()).toBe(5001);
    expect(randomPart(second)).toBe(0x00042);
    expect(second > first).toBe(true);
  });
});
