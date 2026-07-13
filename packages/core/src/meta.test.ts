/**
 * メタデータの検証。
 *
 * 壊れた ccx.json を「読めなかったので無い扱い」にすると、repodir が正体不明の
 * ディレクトリに落ちる。ここで固定するのは、壊れ方ごとに理由が言えること、そして
 * 検証を通らない値を meta として渡さないこと。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadMeta,
  loadState,
  META_SCHEMA,
  metaPath,
  statePath,
  summarizeProblems,
  validateMeta,
  validateState,
  type RepodirMeta,
} from "./meta.ts";

const validMeta: RepodirMeta = {
  schema: META_SCHEMA,
  initialTask: "fix the flaky test",
  goal: { issue: "owner/repo#123" },
  pr: { milestone: "v1.0.0", reviewers: ["someone"] },
  agent: "claude",
  model: "opus-4.8",
  baseBranch: "main",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
  created: "2026-07-13T01:02:03.000Z",
  createdBy: "session:abc",
  ccxVersion: "0.1.0",
};

let tmp: string;

/** .git/ を持つ repodir を 1 つ作る。files に null を渡した中身は「書かない」 */
async function repodir(
  name: string,
  files: { meta?: string | null; state?: string | null },
): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(join(dir, ".git"), { recursive: true });
  if (files.meta != null) await Bun.write(metaPath(dir), files.meta);
  if (files.state != null) await Bun.write(statePath(dir), files.state);
  return dir;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ccx-meta-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("validateMeta", () => {
  test("通る meta は値をそのまま返し、問題を出さない", () => {
    const r = validateMeta(validMeta);
    expect(r.problems).toEqual([]);
    expect(r.value).toEqual(validMeta);
  });

  test("任意フィールドが無くても通る", () => {
    const { initialTask, goal, pr, model, ...minimal } = validMeta;
    const r = validateMeta(minimal);
    expect(r.problems).toEqual([]);
    expect(r.value).toEqual(minimal as RepodirMeta);
  });

  test("未知のキーは無視する (前方互換は schema 番号が担う)", () => {
    const r = validateMeta({ ...validMeta, somethingNew: 42 });
    expect(r.problems).toEqual([]);
  });

  test("JSON オブジェクトでなければ弾く", () => {
    for (const raw of [null, 42, "x", ["a"]]) {
      const r = validateMeta(raw);
      expect(r.value).toBeNull();
      expect(r.problems[0]?.kind).toBe("invalid");
    }
  });

  test("schema が無い / 数でない場合は弾く", () => {
    for (const schema of [undefined, "1", 0, 1.5]) {
      const r = validateMeta({ ...validMeta, schema });
      expect(r.value).toBeNull();
      expect(r.problems[0]?.kind).toBe("invalid");
      expect(r.problems[0]?.message).toContain("schema version");
    }
  });

  test("未来の schema は upgrade を促す。読めたフィールドで解釈しない", () => {
    const r = validateMeta({ ...validMeta, schema: META_SCHEMA + 1 });
    expect(r.value).toBeNull();
    expect(r.problems[0]?.kind).toBe("schema-newer");
    expect(r.problems[0]?.message).toContain("upgrade ccx");
  });

  test("古い schema は migration が要ると言う", () => {
    // 将来 META_SCHEMA が上がったときの経路。expected を動かして固定しておく
    const r = validateMeta(validMeta, META_SCHEMA + 1);
    expect(r.value).toBeNull();
    expect(r.problems[0]?.kind).toBe("schema-older");
    expect(r.problems[0]?.message).toContain("no migration exists");
  });

  test("必須フィールドの欠落と型違いをすべて挙げる", () => {
    const r = validateMeta({ schema: META_SCHEMA, agent: 1, baseBranch: "" });
    expect(r.value).toBeNull();

    const messages = r.problems.map((p) => p.message).join("\n");
    expect(messages).toContain("agent must be a non-empty string");
    expect(messages).toContain("baseBranch must be a non-empty string");
    expect(messages).toContain("baseCommit is missing");
    expect(messages).toContain("createdBy is missing");
    expect(messages).toContain("ccxVersion is missing");
    expect(messages).toContain("created is missing");
    expect(r.problems.every((p) => p.kind === "invalid" && p.file === "ccx.json")).toBe(true);
  });

  test("created が ISO-8601 でなければ弾く", () => {
    const r = validateMeta({ ...validMeta, created: "yesterday" });
    expect(r.value).toBeNull();
    expect(r.problems[0]?.message).toContain("ISO-8601");
  });

  test("goal / pr の中身も見る。指摘には親の名前を被せる", () => {
    const r = validateMeta({
      ...validMeta,
      goal: { issue: 123 },
      pr: { milestone: 5, reviewers: ["ok", ""] },
    });
    expect(r.value).toBeNull();

    // "issue must be ..." だけでは goal 配下か top-level か読み手に判別できない
    const messages = r.problems.map((p) => p.message);
    expect(messages).toContain("ccx.json: goal.issue must be a non-empty string");
    expect(messages).toContain("ccx.json: pr.milestone must be a non-empty string");
    expect(messages).toContain("ccx.json: pr.reviewers must be an array of non-empty strings");

    // 親の名前は checkNested が 1 度だけ被せる (pr.pr.reviewers にならない)
    expect(messages.some((m) => m.includes("pr.pr."))).toBe(false);
  });

  test("goal が object でなければ弾く", () => {
    const r = validateMeta({ ...validMeta, goal: "owner/repo#1" });
    expect(r.value).toBeNull();
    expect(r.problems[0]?.message).toContain("goal must be an object");
  });
});

describe("validateState", () => {
  test("通る state を返す", () => {
    const r = validateState({ desired: "running", done: null });
    expect(r.problems).toEqual([]);
    expect(r.value).toEqual({ desired: "running", done: null });
  });

  test("done を持つ state を返す", () => {
    const done = { at: "2026-07-13T00:00:00.000Z", by: "session:abc" };
    const r = validateState({ desired: "stopped", done });
    expect(r.value).toEqual({ desired: "stopped", done });
  });

  test("未知の desired は弾く", () => {
    const r = validateState({ desired: "paused", done: null });
    expect(r.value).toBeNull();
    expect(r.problems[0]?.file).toBe("ccx.state");
    expect(r.problems[0]?.message).toContain("desired");
  });

  test("done の中身が壊れていれば弾く", () => {
    const r = validateState({ desired: "stopped", done: { at: "soon" } });
    expect(r.value).toBeNull();

    const messages = r.problems.map((p) => p.message).join("\n");
    expect(messages).toContain("done.at must be an ISO-8601 timestamp");
    expect(messages).toContain("done.by is missing");
  });
});

describe("loadMeta / loadState", () => {
  test("健全な repodir は値を返し、問題を出さない", async () => {
    const dir = await repodir("healthy", {
      meta: JSON.stringify(validMeta),
      state: JSON.stringify({ desired: "stopped", done: null }),
    });

    const meta = await loadMeta(dir);
    expect(meta.value).toEqual(validMeta);
    expect(meta.problems).toEqual([]);

    const state = await loadState(dir);
    expect(state.value).toEqual({ desired: "stopped", done: null });
    expect(state.problems).toEqual([]);
  });

  test("ファイルが無ければ missing として持ち上げる。黙って無い扱いにしない", async () => {
    const dir = await repodir("empty", {});

    const meta = await loadMeta(dir);
    expect(meta.value).toBeNull();
    expect(meta.problems[0]?.kind).toBe("missing");
    expect(meta.problems[0]?.message).toBe("ccx.json: is missing");

    const state = await loadState(dir);
    expect(state.problems[0]?.kind).toBe("missing");
    expect(state.problems[0]?.file).toBe("ccx.state");
  });

  test("JSON として壊れていても throw せず、理由を返す", async () => {
    const dir = await repodir("truncated", { meta: '{ "schema": 1, "agent"' });

    const meta = await loadMeta(dir);
    expect(meta.value).toBeNull();
    expect(meta.problems[0]?.kind).toBe("unreadable");
    expect(meta.problems[0]?.message).toContain("cannot be read");
  });

  test("schema に合わない中身は meta として渡さない", async () => {
    const dir = await repodir("invalid", {
      meta: JSON.stringify({ ...validMeta, agent: null }),
    });

    const meta = await loadMeta(dir);
    expect(meta.value).toBeNull();
    expect(meta.problems).toHaveLength(1);
    expect(meta.problems[0]?.kind).toBe("invalid");
  });
});

describe("summarizeProblems", () => {
  test("問題が無ければ null", () => {
    expect(summarizeProblems([])).toBeNull();
  });

  test("1 件ならそのまま", () => {
    const [p] = validateMeta({}).problems;
    expect(summarizeProblems([p!])).toBe(p!.message);
  });

  test("複数あれば先頭 + 残りの件数", () => {
    const { problems } = validateMeta({ schema: META_SCHEMA });
    expect(problems.length).toBeGreaterThan(1);
    expect(summarizeProblems(problems)).toBe(
      `${problems[0]!.message} (+${problems.length - 1} more)`,
    );
  });
});
