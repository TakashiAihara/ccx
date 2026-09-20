import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_DECLARED,
  flagsOf,
  isEmptyDeclared,
  markedSessionIds,
  normalizeDeclared,
  readDeclared,
  resolveSessionId,
  sameDeclared,
  writeDeclared,
} from "./session-state.ts";

const SID = "0f9a1b2c-3d4e-4f60-8a7b-9c0d1e2f3a4b";
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ccx-state-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("session-state: local files under ~/.claude/sessions/<id>/", () => {
  test("nothing written reads as the empty state, and ephemeral lives in a file named `delete`", async () => {
    expect(await readDeclared(SID, home)).toEqual(EMPTY_DECLARED);
    expect(isEmptyDeclared(await readDeclared(SID, home))).toBe(true);

    // 利用者側の script が置いていた形 (空ファイル / テキスト) をそのまま読む
    const dir = join(home, "sessions", SID);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "done"), "");
    await Bun.write(join(dir, "delete"), "");
    await Bun.write(join(dir, "label"), "scope｜step\n");
    await Bun.write(join(dir, "archived"), "");
    const s = await readDeclared(SID, home);
    expect(s).toEqual({ archived: true, done: true, pinned: false, ephemeral: true, label: "scope｜step", task: "" });
    expect(flagsOf(s)).toEqual(["archived", "done", "ephemeral"]);
    // 名前が `ephemeral` のファイルは印ではない (SessionEnd hook は `delete` を読む)
    await rm(join(dir, "delete"));
    await Bun.write(join(dir, "ephemeral"), "");
    expect((await readDeclared(SID, home)).ephemeral).toBe(false);
  });

  test("writeDeclared touches only the keys given, clears on false / empty string, and reads back", async () => {
    expect(await writeDeclared(SID, { done: true, label: "x" }, home)).toEqual({ ...EMPTY_DECLARED, done: true, label: "x" });
    expect(await Bun.file(join(home, "sessions", SID, "done")).exists()).toBe(true);
    expect(await Bun.file(join(home, "sessions", SID, "label")).text()).toBe("x\n");

    // pinned / task を書いても done / label は残る
    expect(await writeDeclared(SID, { pinned: true, task: "kaneo ccx#1" }, home)).toEqual({
      archived: false,
      done: true,
      pinned: true,
      ephemeral: false,
      label: "x",
      task: "kaneo ccx#1",
    });
    expect(await writeDeclared(SID, { done: false, label: "" }, home)).toEqual({ ...EMPTY_DECLARED, pinned: true, task: "kaneo ccx#1" });
    expect(await Bun.file(join(home, "sessions", SID, "done")).exists()).toBe(false);
    expect(await Bun.file(join(home, "sessions", SID, "label")).exists()).toBe(false);
    // ephemeral は `delete` に書く
    await writeDeclared(SID, { ephemeral: true }, home);
    expect(await Bun.file(join(home, "sessions", SID, "delete")).exists()).toBe(true);
    expect(await Bun.file(join(home, "sessions", SID, "ephemeral")).exists()).toBe(false);
  });

  test("normalizeDeclared fills missing keys and drops wrong types; sameDeclared compares every field", () => {
    expect(normalizeDeclared(null)).toEqual(EMPTY_DECLARED);
    expect(normalizeDeclared({ done: "yes", label: 3, task: "t", pinned: true })).toEqual({ ...EMPTY_DECLARED, pinned: true, task: "t" });
    // 4 つの flag それぞれが `=== true` で見ていること (truthy な文字列は false)
    expect(normalizeDeclared({ archived: "yes", done: "yes", pinned: "yes", ephemeral: "yes" })).toEqual(EMPTY_DECLARED);
    expect(normalizeDeclared({ archived: true, done: true, pinned: true, ephemeral: true })).toEqual({ ...EMPTY_DECLARED, archived: true, done: true, pinned: true, ephemeral: true });
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED })).toBe(true);
    for (const k of ["archived", "done", "pinned", "ephemeral"] as const) expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED, [k]: true })).toBe(false);
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED, label: "a" })).toBe(false);
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED, task: "a" })).toBe(false);
  });

  test("markedSessionIds lists uuid dirs only; resolveSessionId accepts a full id anywhere and a prefix only when unique", async () => {
    await writeDeclared(SID, { done: true }, home);
    await mkdir(join(home, "sessions", "not-a-uuid"), { recursive: true });
    await Bun.write(join(home, "sessions", "12345.json"), "{}");
    // 印を外して空になったディレクトリ / Claude Code 自身のファイルしか無いディレクトリは数えない
    const cleared = `${SID.slice(0, 8)}-0000-4000-8000-000000000000`;
    await writeDeclared(cleared, { done: true }, home);
    await writeDeclared(cleared, { done: false }, home);
    await Bun.write(join(home, "sessions", cleared, "label-history.json"), "{}");
    expect(await markedSessionIds(home)).toEqual([SID]);
    expect(await markedSessionIds(join(home, "nope"))).toEqual([]);

    const other = `${SID.slice(0, 8)}-ffff-4fff-8fff-ffffffffffff`;
    expect(resolveSessionId(SID.slice(0, 8), [SID])).toBe(SID);
    // 大文字で受けても小文字の id に解く (Linux では別ディレクトリになり、push が印を見失う)
    expect(resolveSessionId(SID.toUpperCase(), [])).toBe(SID);
    expect(resolveSessionId(SID.slice(0, 8).toUpperCase(), [SID])).toBe(SID);
    expect(() => resolveSessionId(SID.slice(0, 8), [SID, other])).toThrow(/matches 2 sessions/);
    expect(resolveSessionId(SID.slice(0, 10), [SID, other])).toBe(SID);
    expect(() => resolveSessionId("ffffffff", [SID])).toThrow(/no local session/);
    // 完全な id は手元に無くても通す (印は transcript より前に付けることがある)
    expect(resolveSessionId(other, [])).toBe(other);
  });
});
