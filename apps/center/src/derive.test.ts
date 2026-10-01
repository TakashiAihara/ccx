import { describe, expect, test } from "bun:test";

import { derive } from "./derive.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("derive", () => {
  test("実際の hook payload から 4 つの値を取り出す", () => {
    const d = derive(
      enc(
        JSON.stringify({
          session_id: "01a050b0-4c8c-7e7a-9e2b-eac10c8aa716",
          hook_event_name: "Stop",
          cwd: "/home/dev/repo",
          transcript_path: "/home/dev/.claude/projects/x/y.jsonl",
          permission_mode: "bypassPermissions",
        }),
      ),
    );
    expect(d).toEqual({
      parsed: true,
      sessionId: "01a050b0-4c8c-7e7a-9e2b-eac10c8aa716",
      hookEventName: "Stop",
      cwd: "/home/dev/repo",
      transcriptPath: "/home/dev/.claude/projects/x/y.jsonl",
    });
  });

  test("キーが無くても parsed は true。読めたことと、値があることは別", () => {
    const d = derive(enc(JSON.stringify({ something_else: 1 })));
    expect(d.parsed).toBe(true);
    expect(d.sessionId).toBe("");
    expect(d.hookEventName).toBe("");
  });

  test("UTF-8 として不正なら parsed は false", () => {
    // 0xff は UTF-8 のどの位置にも現れないバイト。
    expect(derive(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({ parsed: false });
  });

  test("U+FFFD に置換して読めたことにしない", () => {
    // fatal:true でなければ 0xff は置換文字になり JSON.parse まで到達しうる。
    // 到達しないことを、置換後に妥当な JSON になる並びで確かめる。
    const bad = new Uint8Array([...enc('{"session_id":"'), 0xff, ...enc('"}')]);
    expect(derive(bad).parsed).toBe(false);
  });

  test("JSON でなければ parsed は false", () => {
    expect(derive(enc("not json at all")).parsed).toBe(false);
    expect(derive(enc("")).parsed).toBe(false);
  });

  test("オブジェクトでない JSON は読めなかった扱い", () => {
    for (const s of ["[1,2,3]", '"a string"', "42", "null", "true"]) {
      expect(derive(enc(s)).parsed).toBe(false);
    }
  });

  test("文字列でない値は String() で潰さず、無かったものとして扱う", () => {
    const d = derive(
      enc(JSON.stringify({ session_id: 42, hook_event_name: { a: 1 }, cwd: null })),
    );
    expect(d.parsed).toBe(true);
    expect(d.sessionId).toBe("");
    expect(d.hookEventName).toBe("");
    expect(d.cwd).toBe("");
  });
});
