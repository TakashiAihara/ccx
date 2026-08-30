import { describe, expect, test } from "bun:test";

import { humanSince, parseLimit, shortId, table } from "./format.ts";

describe("humanSince", () => {
  const now = 1_000_000_000_000;
  test("秒・分・時・日で丸める", () => {
    expect(humanSince(now - 5_000, now)).toBe("5s");
    expect(humanSince(now - 90_000, now)).toBe("2m");
    expect(humanSince(now - 3 * 3600_000, now)).toBe("3h");
    expect(humanSince(now - 5 * 86400_000, now)).toBe("5d");
  });

  test("未来の時刻でも負にしない (機械の時計はずれる)", () => {
    expect(humanSince(now + 60_000, now)).toBe("0s");
  });
});

describe("table", () => {
  test("列を揃え、最終列は詰めない", () => {
    expect(table([["a", "xx"], ["bbb", "y"]])).toEqual(["a    xx", "bbb  y"]);
  });

  test("空の表で落ちない", () => {
    // Math.max(...[]) は -Infinity になる。padEnd(-Infinity) は例外を投げる
    expect(table([])).toEqual([]);
  });

  test("欠けたセルを穴として扱う", () => {
    expect(table([["a", "b"], ["c"]])).toEqual(["a  b", "c"]);
  });
});

describe("shortId", () => {
  test("UUID は先頭 8 文字", () => {
    expect(shortId("7c00c9a5-e8af-41d0-98e3-6599dce0599f")).toBe("7c00c9a5");
  });

  test("UUID でない id はそのまま。切ると別物になる", () => {
    // ハイフンの有無で判定すると、これが "smoke-te" に化ける
    expect(shortId("smoke-test-0001")).toBe("smoke-test-0001");
    expect(shortId("short")).toBe("short");
    // UUID に見えるが 16 進でない
    expect(shortId("zzzzzzzz-e8af-41d0-98e3-6599dce0599f")).toBe("zzzzzzzz-e8af-41d0-98e3-6599dce0599f");
  });
});

describe("parseLimit", () => {
  test("未指定は 0 = center の既定に任せる", () => {
    expect(parseLimit(undefined)).toBe(0);
  });

  test("正の整数はそのまま", () => {
    expect(parseLimit("5")).toBe(5);
    expect(parseLimit(5)).toBe(5);
  });

  test("0 は落とす。契約では 0 が「指定なし」なので、黙って 100 件返ることになる", () => {
    expect(() => parseLimit("0")).toThrow(/positive integer/);
  });

  test("負・小数・数でないものも落とす", () => {
    for (const v of ["-1", "1.5", "abc", ""]) {
      expect(() => parseLimit(v)).toThrow(/positive integer/);
    }
  });
});
