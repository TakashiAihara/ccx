import { describe, expect, test } from "bun:test";

import { isLoopback, loadCenterConfig } from "./config.ts";

describe("loadCenterConfig", () => {
  test("何も無ければ loopback の 8791", () => {
    const c = loadCenterConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8791);
  });

  test("既定が loopback なのは認証がまだ無いから。0.0.0.0 に勝手に開かない", () => {
    expect(loadCenterConfig({}).host).toBe("127.0.0.1");
    // 非 loopback は明示の opt-in が要る (下の describe で見ている)
    expect(() => loadCenterConfig({ CCX_CENTER_HOST: "0.0.0.0" })).toThrow();
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

describe("非 loopback bind", () => {
  test("loopback は 127.0.0.1 だけではない", () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "localhost", "::1", "[::1]"]) {
      expect(isLoopback(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.0.10", "10.0.0.1", "example.com", "1270.0.0.1", ""]) {
      expect(isLoopback(h)).toBe(false);
    }
  });

  test("認証も TLS も無いので、非 loopback は既定で拒む", () => {
    expect(() => loadCenterConfig({ CCX_CENTER_HOST: "0.0.0.0" })).toThrow(/no authentication/);
    expect(() => loadCenterConfig({ CCX_CENTER_HOST: "192.168.0.10" })).toThrow(/refusing to bind/);
  });

  test("明示の opt-in があれば通す。設定 1 つで越えられる線にはしない", () => {
    const c = loadCenterConfig({ CCX_CENTER_HOST: "0.0.0.0", CCX_CENTER_ALLOW_INSECURE_BIND: "1" });
    expect(c.host).toBe("0.0.0.0");
  });

  test("loopback なら opt-in は要らない", () => {
    expect(loadCenterConfig({ CCX_CENTER_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(loadCenterConfig({}).host).toBe("127.0.0.1");
  });
});
