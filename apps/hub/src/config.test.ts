import { describe, expect, test } from "bun:test";

import { loadCenterConfig } from "./config.ts";

describe("loadCenterConfig", () => {
  test("何も無ければ loopback の 8791", () => {
    const c = loadCenterConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8791);
  });

  test("既定が loopback なのは認証がまだ無いから。0.0.0.0 に勝手に開かない", () => {
    expect(loadCenterConfig({}).host).toBe("127.0.0.1");
    expect(loadCenterConfig({ CCX_CENTER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  test("空文字の CCX_CENTER_PORT は未設定として扱う", () => {
    // Number("") は 0 で、範囲チェックも 0 を通す。素通りさせると 8791 ではなく
    // 任意の空きポートに bind され、誰も気づかない
    expect(loadCenterConfig({ CCX_CENTER_PORT: "" }).port).toBe(8791);
    expect(loadCenterConfig({ CCX_CENTER_PORT: "   " }).port).toBe(8791);
  });

  test("明示の 0 は受ける (空きポートを任せる指定として意味がある)", () => {
    expect(loadCenterConfig({ CCX_CENTER_PORT: "0" }).port).toBe(0);
  });

  test("ポートとして読めない値は落とす", () => {
    for (const v of ["abc", "-1", "70000", "80.5"]) {
      expect(() => loadCenterConfig({ CCX_CENTER_PORT: v })).toThrow();
    }
  });

  test("DB は CCX_ROOT の下。CCX_CENTER_DB があればそちらが勝つ", () => {
    expect(loadCenterConfig({ CCX_ROOT: "/r" }).dbPath).toBe("/r/center.db");
    expect(loadCenterConfig({ CCX_ROOT: "/r", CCX_CENTER_DB: "/x/y.db" }).dbPath).toBe("/x/y.db");
  });
});
