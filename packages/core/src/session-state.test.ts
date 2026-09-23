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
  test("nothing written reads as the empty state; archived is an empty file, label the hook's text file", async () => {
    expect(await readDeclared(SID, home)).toEqual(EMPTY_DECLARED);
    expect(isEmptyDeclared(await readDeclared(SID, home))).toBe(true);

    const dir = join(home, "sessions", SID);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "archived"), "");
    await Bun.write(join(dir, "label"), "scope｜step\n");
    // 利用者側の marker (done / pinned / delete) は ccx の状態ではない: 読まない
    await Bun.write(join(dir, "done"), "");
    await Bun.write(join(dir, "pinned"), "");
    await Bun.write(join(dir, "delete"), "");
    const s = await readDeclared(SID, home);
    expect(s).toEqual({ archived: true, label: "scope｜step", task: "", heartbeat: "" });
    expect(flagsOf(s)).toEqual(["archived"]);
  });

  test("writeDeclared touches only the keys given, clears on false / empty string, and reads back", async () => {
    expect(await writeDeclared(SID, { archived: true, label: "x" }, home)).toEqual({ archived: true, label: "x", task: "", heartbeat: "" });
    expect(await Bun.file(join(home, "sessions", SID, "archived")).exists()).toBe(true);
    expect(await Bun.file(join(home, "sessions", SID, "label")).text()).toBe("x\n");

    // task を書いても archived / label は残る
    expect(await writeDeclared(SID, { task: "kaneo ccx#1" }, home)).toEqual({ archived: true, label: "x", task: "kaneo ccx#1", heartbeat: "" });
    expect(await writeDeclared(SID, { archived: false, label: "" }, home)).toEqual({ ...EMPTY_DECLARED, task: "kaneo ccx#1" });
    expect(await Bun.file(join(home, "sessions", SID, "archived")).exists()).toBe(false);
    expect(await Bun.file(join(home, "sessions", SID, "label")).exists()).toBe(false);
  });

  test("heartbeat is on / off / unset; anything else in the file or the store reads as unset", async () => {
    const file = join(home, "sessions", SID, "heartbeat");
    expect((await writeDeclared(SID, { heartbeat: "off" }, home)).heartbeat).toBe("off");
    expect(await Bun.file(file).text()).toBe("off\n");
    expect(isEmptyDeclared(await readDeclared(SID, home))).toBe(false);
    expect((await writeDeclared(SID, { heartbeat: "on" }, home)).heartbeat).toBe("on");
    expect((await writeDeclared(SID, { heartbeat: "" }, home)).heartbeat).toBe("");
    expect(await Bun.file(file).exists()).toBe(false);

    await Bun.write(file, "maybe\n");
    expect((await readDeclared(SID, home)).heartbeat).toBe("");
    expect(normalizeDeclared({ heartbeat: "yes" }).heartbeat).toBe("");
    expect(normalizeDeclared({ heartbeat: "off" }).heartbeat).toBe("off");
    expect(sameDeclared({ ...EMPTY_DECLARED, heartbeat: "on" }, EMPTY_DECLARED)).toBe(false);
  });

  test("normalizeDeclared fills missing keys and drops wrong types; sameDeclared compares every field", () => {
    expect(normalizeDeclared(null)).toEqual(EMPTY_DECLARED);
    // truthy な文字列は true ではない。知らない鍵 (done 等) は捨てる
    expect(normalizeDeclared({ archived: "yes", label: 3, task: "t", done: true })).toEqual({ ...EMPTY_DECLARED, task: "t" });
    expect(normalizeDeclared({ archived: true })).toEqual({ ...EMPTY_DECLARED, archived: true });
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED })).toBe(true);
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED, archived: true })).toBe(false);
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED, label: "a" })).toBe(false);
    expect(sameDeclared(EMPTY_DECLARED, { ...EMPTY_DECLARED, task: "a" })).toBe(false);
  });

  test("markedSessionIds lists uuid dirs with a mark only; resolveSessionId accepts a full id anywhere and a prefix only when unique", async () => {
    await writeDeclared(SID, { archived: true }, home);
    await mkdir(join(home, "sessions", "not-a-uuid"), { recursive: true });
    await Bun.write(join(home, "sessions", "12345.json"), "{}");
    // 印を外して空になったディレクトリ / hook のファイルしか無いディレクトリは数えない
    const cleared = `${SID.slice(0, 8)}-0000-4000-8000-000000000000`;
    await writeDeclared(cleared, { archived: true }, home);
    await writeDeclared(cleared, { archived: false }, home);
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
