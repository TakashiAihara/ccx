/**
 * repodir のメタデータ。2 ファイルに分ける。
 *
 *   .git/ccx.json   生成時に確定する不変の事実。ccx repodir new のみが書く
 *   .git/ccx.state  可変のライフサイクル。ccx / ccxd が書く
 *
 * .git/ 配下に置くのは (a) git status に出ない、(b) agent が誤ってコミットする
 * ことが原理的に不可能、(c) dir と生死を共にし孤児が残らない、の 3 点による。
 *
 * 導出できるものは持たない。host / owner / repo は path から、created は dir-id から、
 * branch / dirty / 未 push は git から、session は Claude のプロジェクトディレクトリから
 * 導出できるので、ここには書かない (created だけは可読性のため明示的に持つ)。
 */

import { join } from "node:path";

export const META_SCHEMA = 1;

export type Goal = {
  issue?: string;
  clickup?: string;
};

export type PrIntent = {
  /** Issue を立てない repodir 用。Issue があれば Issue 側から導出できる */
  milestone?: string;
  reviewers?: string[];
};

export type RepodirMeta = {
  schema: number;
  /** 生成時に与えたタスク。「いま何をしているか」ではなく「何のために生まれたか」 */
  initialTask?: string;
  goal?: Goal;
  pr?: PrIntent;
  /** rd open のデフォルト。claude / opencode / cursor 等 */
  agent: string;
  model?: string;
  /** どこから生えたか。後から確実に復元できない */
  baseBranch: string;
  baseCommit: string;
  created: string;
  /** "user" または "session:<id>" */
  createdBy: string;
  ccxVersion: string;
};

export type DesiredState = "running" | "stopped";

export type RepodirState = {
  desired: DesiredState;
  done: { at: string; by: string } | null;
};

export const metaPath = (dir: string) => join(dir, ".git", "ccx.json");
export const statePath = (dir: string) => join(dir, ".git", "ccx.state");

export async function writeMeta(dir: string, meta: RepodirMeta): Promise<void> {
  await Bun.write(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function readMeta(dir: string): Promise<RepodirMeta | null> {
  const f = Bun.file(metaPath(dir));
  if (!(await f.exists())) return null;
  return (await f.json()) as RepodirMeta;
}

export async function writeState(dir: string, state: RepodirState): Promise<void> {
  await Bun.write(statePath(dir), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readState(dir: string): Promise<RepodirState | null> {
  const f = Bun.file(statePath(dir));
  if (!(await f.exists())) return null;
  return (await f.json()) as RepodirState;
}

/* ------------------------------------------------------------------ *
 * 検証
 *
 * メタデータが読めない repodir は「正体不明のディレクトリ」になる。各 dir に
 * メタデータを持たせたのは、まさにそれを防ぐためだった。だから壊れていても黙って
 * 飛ばさず、何がどう壊れているかを言える形にして返す。
 *
 * schema 番号の不一致もここで見る。未来の schema (この ccx より新しい ccx が書いた)
 * を「たまたま読めたフィールドだけ」で解釈すると、静かに誤った状態を見せる。将来
 * migration を入れるときの入口もここになる。
 * ------------------------------------------------------------------ */

export type MetaFile = "ccx.json" | "ccx.state";

export type MetaProblemKind =
  /** ファイルが無い */
  | "missing"
  /** 読めない / JSON として壊れている */
  | "unreadable"
  /** JSON ではあるが、期待する形をしていない */
  | "invalid"
  /** この ccx より新しい schema。ccx を上げるべき */
  | "schema-newer"
  /** 古い schema。migration が要る */
  | "schema-older";

export type MetaProblem = {
  file: MetaFile;
  kind: MetaProblemKind;
  /** そのまま 1 行で表示できる理由 */
  message: string;
};

/** 検証を通った値と、見つかった問題。値が null でも problems だけは必ず返る */
export type Loaded<T> = {
  value: T | null;
  problems: MetaProblem[];
};

const problem = (file: MetaFile, kind: MetaProblemKind, message: string): MetaProblem => ({
  file,
  kind,
  message: `${file}: ${message}`,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 必須 / 任意の文字列フィールドを見る。空文字は「書いたが値が無い」なので通さない */
function checkString(
  obj: Record<string, unknown>,
  field: string,
  required: boolean,
  errs: string[],
): void {
  const v = obj[field];
  if (v === undefined) {
    if (required) errs.push(`${field} is missing`);
    return;
  }
  if (typeof v !== "string" || v === "") errs.push(`${field} must be a non-empty string`);
}

function checkIsoDate(obj: Record<string, unknown>, field: string, errs: string[]): void {
  const v = obj[field];
  if (v === undefined) {
    errs.push(`${field} is missing`);
    return;
  }
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    errs.push(`${field} must be an ISO-8601 timestamp`);
  }
}

/**
 * ネストしたオブジェクトを検証する。中の指摘には必ず親の名前を被せる。
 *
 * "issue must be a non-empty string" だけでは、それが goal 配下なのか top-level なのか
 * 読み手に判別できず、「壊れ方ごとに理由が言える」という本来の目的を損なう。
 *
 * 未知のキーは弾かない。前方互換のため無視する (schema 番号が破壊的変更を担う)。
 */
function checkNested(
  obj: Record<string, unknown>,
  field: string,
  errs: string[],
  check: (v: Record<string, unknown>, errs: string[]) => void,
): void {
  const v = obj[field];
  if (v === undefined) return;
  if (!isRecord(v)) {
    errs.push(`${field} must be an object`);
    return;
  }

  const nested: string[] = [];
  check(v, nested);
  errs.push(...nested.map((e) => `${field}.${e}`));
}

/**
 * expected は現在の schema。migration を入れるときはここが分岐点になるので、
 * 定数直参照ではなく引数にしてある (テストからも動かせる)。
 */
export function validateMeta(raw: unknown, expected: number = META_SCHEMA): Loaded<RepodirMeta> {
  const fail = (kind: MetaProblemKind, message: string): Loaded<RepodirMeta> => ({
    value: null,
    problems: [problem("ccx.json", kind, message)],
  });

  if (!isRecord(raw)) return fail("invalid", "is not a JSON object");

  const { schema } = raw;
  if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1) {
    return fail("invalid", "has no valid schema version");
  }
  if (schema > expected) {
    return fail(
      "schema-newer",
      `is schema ${schema}, but this ccx understands ${expected} — upgrade ccx`,
    );
  }
  if (schema < expected) {
    return fail(
      "schema-older",
      `is schema ${schema}, but this ccx expects ${expected} — no migration exists`,
    );
  }

  const errs: string[] = [];

  checkString(raw, "agent", true, errs);
  checkString(raw, "baseBranch", true, errs);
  checkString(raw, "baseCommit", true, errs);
  checkString(raw, "createdBy", true, errs);
  checkString(raw, "ccxVersion", true, errs);
  checkIsoDate(raw, "created", errs);

  checkString(raw, "initialTask", false, errs);
  checkString(raw, "model", false, errs);

  checkNested(raw, "goal", errs, (goal, e) => {
    checkString(goal, "issue", false, e);
    checkString(goal, "clickup", false, e);
  });

  checkNested(raw, "pr", errs, (pr, e) => {
    checkString(pr, "milestone", false, e);
    const { reviewers } = pr;
    if (reviewers !== undefined) {
      if (!Array.isArray(reviewers) || reviewers.some((r) => typeof r !== "string" || r === "")) {
        // 親の名前は checkNested が被せる。ここで "pr." を書くと二重になる
        e.push("reviewers must be an array of non-empty strings");
      }
    }
  });

  if (errs.length > 0) {
    return {
      value: null,
      problems: errs.map((e) => problem("ccx.json", "invalid", e)),
    };
  }

  return { value: raw as RepodirMeta, problems: [] };
}

export function validateState(raw: unknown): Loaded<RepodirState> {
  const fail = (message: string): Loaded<RepodirState> => ({
    value: null,
    problems: [problem("ccx.state", "invalid", message)],
  });

  if (!isRecord(raw)) return fail("is not a JSON object");

  const { desired, done } = raw;
  if (desired !== "running" && desired !== "stopped") {
    return fail('desired must be "running" or "stopped"');
  }

  if (done !== null && done !== undefined) {
    if (!isRecord(done)) return fail("done must be an object or null");

    const errs: string[] = [];
    checkIsoDate(done, "at", errs);
    checkString(done, "by", true, errs);
    if (errs.length > 0) {
      return { value: null, problems: errs.map((e) => problem("ccx.state", "invalid", `done.${e}`)) };
    }
  }

  return {
    value: { desired, done: (done ?? null) as RepodirState["done"] },
    problems: [],
  };
}

async function loadJson<T>(
  path: string,
  file: MetaFile,
  validate: (raw: unknown) => Loaded<T>,
): Promise<Loaded<T>> {
  const f = Bun.file(path);

  if (!(await f.exists())) {
    return { value: null, problems: [problem(file, "missing", "is missing")] };
  }

  let raw: unknown;
  try {
    raw = await f.json();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { value: null, problems: [problem(file, "unreadable", `cannot be read — ${why}`)] };
  }

  return validate(raw);
}

/** 検証済みの ccx.json を読む。壊れていても throw せず、理由を problems で返す */
export function loadMeta(dir: string): Promise<Loaded<RepodirMeta>> {
  return loadJson(metaPath(dir), "ccx.json", validateMeta);
}

/** 検証済みの ccx.state を読む。壊れていても throw せず、理由を problems で返す */
export function loadState(dir: string): Promise<Loaded<RepodirState>> {
  return loadJson(statePath(dir), "ccx.state", validateState);
}

/** problems を 1 行に畳む。ls の 1 行に収めるため、先頭だけ出して残りは件数にする */
export function summarizeProblems(problems: MetaProblem[]): string | null {
  const [first, ...rest] = problems;
  if (!first) return null;
  return rest.length > 0 ? `${first.message} (+${rest.length} more)` : first.message;
}

/**
 * createdBy を決める。Claude Code の session 内から呼ばれていればその session を、
 * そうでなければ "user" を返す。系譜は後から復元できないのでここで確定させる。
 */
export function detectCreatedBy(env: Record<string, string | undefined> = process.env): string {
  const id = env.CLAUDE_SESSION_ID;
  return id ? `session:${id}` : "user";
}
