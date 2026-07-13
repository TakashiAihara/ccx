/**
 * picker の契約。
 *
 * 守りたいのは 2 つ。
 *   - 選択の手がかりは initialTask であり、dir-id ではない (人間は id を読まない)
 *   - 選ばなかったときに repodir を返さない (`cd "$(ccx rd cd)"` で HOME に飛ばさないため)
 *
 * fzf は本物を呼ばず、PATH に差し込んだ偽物で挙動を固定する。fzf に何を渡し、その stdout を
 * どう解釈するかという境界そのものがテスト対象なので、ここを mock で潰すと何も検証できない。
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";

import type { RepodirInfo } from "@ccx/core";

import { candidateLine, pickByNumber, pickRepodir, resolveSelection } from "./pick.ts";

let bin: string;
let emptyBin: string;
let savedPath: string | undefined;

/** 引数で指定した振る舞いをする fzf を PATH の先頭に置く。 */
async function fakeFzf(script: string) {
  await writeFile(join(bin, "fzf"), `#!/bin/sh\n${script}\n`);
  await chmod(join(bin, "fzf"), 0o755);
}

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "ccx-pick-bin-"));
  emptyBin = await mkdtemp(join(tmpdir(), "ccx-pick-nofzf-"));
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
});

function info(dirId: string, task: string | undefined, over: Partial<RepodirInfo> = {}): RepodirInfo {
  return {
    path: `/root/.ccx/github.com/o/r/${dirId}`,
    dirId,
    spec: { host: "github.com", owner: "o", repo: "r" },
    created: new Date(0),
    meta: task === undefined ? null : ({ initialTask: task } as RepodirInfo["meta"]),
    state: null,
    metaError: null,
    git: { branch: "main", dirty: false, unpushed: 0, hasUpstream: true, stashes: 0 },
    session: { active: false, lastActivity: null, transcripts: 0 },
    ...over,
  };
}

test("候補行は dir-id を先頭に持ち、initialTask を載せる", () => {
  const line = candidateLine(info("01AAA", "fix the flaky test"));
  const fields = line.split("\t");

  expect(fields[0]).toBe("01AAA");
  expect(fields[1]).toBe("o/r");
  expect(fields.at(-1)).toBe("fix the flaky test");
});

test("task が無い repodir も候補から落とさない", () => {
  expect(candidateLine(info("01AAA", undefined)).split("\t").at(-1)).toBe("-");
});

test("initialTask の改行・TAB は潰す。1 候補 = 1 行 / TAB 区切りが選択のプロトコルなので", () => {
  const line = candidateLine(info("01AAA", "fix the\nflaky\ttest\n\nin scan.ts"));

  expect(line.split("\n")).toHaveLength(1);
  expect(line.split("\t")).toHaveLength(5); // 列が増えていない
  expect(line.split("\t").at(-1)).toBe("fix the flaky test in scan.ts");
});

test("改行を含む task でも dir-id で引き当てられる (行が割れていない証拠)", () => {
  const infos = [info("01AAA", "a"), info("01BBB", "multi\nline\ttask")];
  const lines = infos.map(candidateLine).join("\n").split("\n");

  expect(lines).toHaveLength(2);
  expect(resolveSelection(infos, lines[1]!)?.dirId).toBe("01BBB");
});

test("壊れた ccx.json は隠さず候補行に出す", () => {
  const line = candidateLine(info("01AAA", undefined, { metaError: "unexpected token" }));
  expect(line.split("\t").at(-1)).toBe("!! unexpected token");
});

test("選択は表示テキストではなく dir-id で引き当てる", () => {
  const infos = [info("01AAA", "a"), info("01BBB", "b")];
  expect(resolveSelection(infos, candidateLine(infos[1]!))?.dirId).toBe("01BBB");
  expect(resolveSelection(infos, "01ZZZ\tо/r\tmain\t-\tx")).toBeNull();
});

test("候補が 1 つなら picker を出さずにそれを返す", async () => {
  await fakeFzf("exit 1"); // 呼ばれたら選べない = 呼んでいないことの証明になる
  const only = info("01AAA", "a");
  expect((await pickRepodir([only]))?.dirId).toBe("01AAA");
});

test("候補ゼロは選択ではなくエラー", async () => {
  expect(pickRepodir([])).rejects.toThrow("no repodirs");
});

test("fzf が返した行の repodir を選ぶ", async () => {
  // 2 行目 (01BBB) を選んだ fzf を演じる
  await fakeFzf("sed -n 2p");
  const picked = await pickRepodir([info("01AAA", "a"), info("01BBB", "b")]);
  expect(picked?.dirId).toBe("01BBB");
});

test("ESC / Ctrl-C (exit 130) は null。repodir を返さない", async () => {
  await fakeFzf("exit 130");
  expect(await pickRepodir([info("01AAA", "a"), info("01BBB", "b")])).toBeNull();
});

test("fzf が何にもマッチせず終わった (exit 1) 場合も null", async () => {
  await fakeFzf("exit 1");
  expect(await pickRepodir([info("01AAA", "a"), info("01BBB", "b")])).toBeNull();
});

test("fzf 自身が壊れて死んだ (tty が無い等) のは握り潰さない", async () => {
  await fakeFzf("exit 2");
  expect(pickRepodir([info("01AAA", "a"), info("01BBB", "b")])).rejects.toThrow("fzf exited with 2");
});

/** 番号選択の入出力を tty ではなくメモリに向ける。 */
function fakeTty(answer: string) {
  const written: string[] = [];
  return {
    tty: {
      input: Readable.from([`${answer}\n`]),
      output: new Writable({
        write(chunk, _enc, cb) {
          written.push(String(chunk));
          cb();
        },
      }),
    },
    written,
  };
}

test("fzf が無ければ番号選択に降り、選ばれた repodir を返す", async () => {
  process.env.PATH = emptyBin; // fzf の無い PATH
  try {
    const { tty, written } = fakeTty("2");
    const picked = await pickRepodir([info("01AAA", "a"), info("01BBB", "fix the webhook")], tty);

    expect(picked?.dirId).toBe("01BBB");
    // 番号選択でも選択の手がかりは task であること
    expect(written.join("")).toContain("fix the webhook");
  } finally {
    process.env.PATH = `${bin}:${savedPath}`;
  }
});

test("番号選択で範囲外を打ったら repodir を返さずエラー", async () => {
  const { tty } = fakeTty("9");
  expect(pickByNumber([info("01AAA", "a"), info("01BBB", "b")], tty)).rejects.toThrow("not a choice");
});

test("番号選択で空入力なら null (選ばなかった)", async () => {
  const { tty } = fakeTty("");
  expect(await pickByNumber([info("01AAA", "a"), info("01BBB", "b")], tty)).toBeNull();
});
