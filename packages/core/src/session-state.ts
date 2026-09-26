/**
 * session の状態 (#127)。ccx が定義し、transcript と一緒に運ぶ (docs/design/scope.md
 * 「Session state is ccx's to hold」)。
 *
 * 2 種類ある。観測 (running / ended / remote) は事実から導き、手では書かない。
 * 宣言 (archived / label / task / heartbeat / metadata) は人か session が書く。archived は
 * Desktop App と同じ語で「一覧から畳む」宣言。「保存先にだけあり手元に無い」観測は remote
 * と呼び、語を分ける。top level は ccx が定義する鍵 (作用する / 形と列を決める)。metadata は利用者の語彙
 * (done / pinned 等) を ccx が意味を持たずに運ぶ入れ物 (#165、#135 の「利用者側の marker は
 * 持たない」を置き換えた): ccx は OSS なので、どの marker を持つかを ccx が決めない。
 *
 * 宣言のローカルの置き場所は `~/.claude/sessions/<id>/` (利用者側の script が marker を
 * 置いていた場所と同じ。Claude Code 自身は `<pid>.json` しか置かない)。`archived` は空
 * ファイル、`label` は auto-label hook が置いていたテキストをそのまま読む、`task` は
 * 新しいテキスト。metadata は `meta/<key>` の 1 key 1 ファイル (中身が値、空なら値なし)。
 * shell の読み手 (statusline / hook) が `[ -e … ]` で読めるように、JSON 1 つにはしない。
 * 保存先には `state.json` 1 つにまとめて置く (transcript.ts が push / pull で運ぶ)。
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const claudeHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export const FLAGS = ["archived"] as const;
export type Flag = (typeof FLAGS)[number];

/** 宣言された状態。無いものは false / 空文字 */
export type DeclaredState = {
  archived: boolean;
  label: string;
  task: string;
  /** この session の heartbeat の上書き。空なら ccx-agent の既定に従う (docs/design/heartbeat.md) */
  heartbeat: Heartbeat;
  /** 利用者の key/value。ccx は意味を持たない。値が空文字でも key があれば「立っている」 */
  metadata: Metadata;
  /** `ccx session label` が label を変えた記録 (#169)。古い順。消した (空文字にした) ことも 1 件 */
  labelHistory: LabelChange[];
};

export type Metadata = Record<string, string>;
/** at は ISO 8601 (UTC) */
export type LabelChange = { at: string; label: string };

/**
 * ファイル名になるので、区切り・`.` 始まり (`..` を含む)・`=` (CLI の `key=value`) を通さない。
 * 小文字だけなのは session id と同じ理由: 大文字小文字を区別しない fs (macOS の既定) では
 * `Done` と `done` が 1 ファイルになり、pull で片方が消える
 */
export const META_KEY = /^[a-z0-9_][a-z0-9_.-]{0,127}$/;
export const META_KEY_RULE = "lowercase letters, digits, _ . - (not starting with . or -), at most 128";
export const isMetaKey = (k: string) => META_KEY.test(k);
const META_DIR = "meta";

/** 渡したものの key が正しい string 値だけを、key 順に並べて返す */
function cleanMetadata(raw: unknown): Metadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // fromEntries で組む: `out[k] = v` だと `__proto__` (正しい key) が prototype の setter に食われて消える
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([k, v]) => isMetaKey(k) && typeof v === "string")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** writeDeclared に渡す差分。metadata は key ごとで、null はその key を消す */
export type DeclaredPatch = Partial<Omit<DeclaredState, "metadata">> & { metadata?: Record<string, string | null> };

/**
 * 1 行 1 変更の JSONL。追記だけなので、並んで走った 2 つの `session label` が互いの行を消さない。
 * auto-label hook の `label-history.json` / `label-trail.jsonl` とは別物 (あちらは hook 固有の形)
 */
const LABEL_HISTORY_FILE = "labels.jsonl";

function cleanLabelHistory(raw: unknown): LabelChange[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is LabelChange => !!e && typeof e === "object" && typeof e.at === "string" && typeof e.label === "string")
    .map(({ at, label }) => ({ at, label }));
}

export const HEARTBEATS = ["on", "off"] as const;
export type Heartbeat = (typeof HEARTBEATS)[number] | "";
const asHeartbeat = (v: unknown): Heartbeat => (HEARTBEATS as readonly unknown[]).includes(v) ? (v as Heartbeat) : "";

export type Lifecycle = "running" | "ended" | "remote" | "unknown";

const FLAG_FILE: Record<Flag, string> = { archived: "archived" };
const TEXT_FILE = { label: "label", task: "task", heartbeat: "heartbeat" } as const;

/**
 * ccx を通して宣言したことがある、の印。空の状態 (全部外した) と「一度も宣言していない」を
 * 分けるためだけに置く。これが無いと、手元で archived を外した session に保存先の古い
 * archived が pull や status で戻ってくる
 */
const DECLARED_FILE = ".ccx-declared";

export const EMPTY_DECLARED: DeclaredState = { archived: false, label: "", task: "", heartbeat: "", metadata: {}, labelHistory: [] };

export const sessionDir = (sessionId: string, home = claudeHome()) => join(home, "sessions", sessionId);

export const isFlag = (s: string): s is Flag => (FLAGS as readonly string[]).includes(s);

export const isEmptyDeclared = (s: DeclaredState) =>
  flagsOf(s).length === 0 && !s.label && !s.task && !s.heartbeat && Object.keys(s.metadata).length === 0 && s.labelHistory.length === 0;

/** 立っている flag の名前。`ls` の列と JSON の両方で使う */
export const flagsOf = (s: DeclaredState): Flag[] => FLAGS.filter((f) => s[f]);

/** 保存先から来た JSON を、欠けた鍵を埋めて DeclaredState にする */
export function normalizeDeclared(raw: unknown): DeclaredState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    archived: r.archived === true,
    label: typeof r.label === "string" ? r.label : "",
    task: typeof r.task === "string" ? r.task : "",
    heartbeat: asHeartbeat(r.heartbeat),
    metadata: cleanMetadata(r.metadata),
    labelHistory: cleanLabelHistory(r.labelHistory),
  };
}

const sameMetadata = (a: Metadata, b: Metadata) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export const sameDeclared = (a: DeclaredState, b: DeclaredState) =>
  FLAGS.every((f) => a[f] === b[f]) &&
  a.label === b.label &&
  a.task === b.task &&
  a.heartbeat === b.heartbeat &&
  sameMetadata(a.metadata, b.metadata) &&
  a.labelHistory.length === b.labelHistory.length &&
  a.labelHistory.every((e, i) => e.at === b.labelHistory[i]!.at && e.label === b.labelHistory[i]!.label);

async function readLabelHistory(dir: string): Promise<LabelChange[]> {
  let text: string;
  try {
    text = await Bun.file(join(dir, LABEL_HISTORY_FILE)).text();
  } catch (e) {
    // meta/ と同じ: 無いのは空、読めないのは止める (空にすると push が保存先の履歴を消す)
    if (errCode(e) === "ENOENT") return [];
    throw e;
  }
  const parsed = text.split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      // 書きかけで切れた行 1 つで履歴全体を失わない
      return [];
    }
  });
  return cleanLabelHistory(parsed);
}

async function readMetadata(dir: string): Promise<Metadata> {
  let names: string[];
  try {
    names = await readdir(join(dir, META_DIR));
  } catch (e) {
    // 無いのは空。読めない (権限 / meta が通常ファイル) を空にすると、push が全 key を消した state.json を送る
    if (errCode(e) === "ENOENT") return {};
    throw e;
  }
  const out: [string, string][] = [];
  // readdir の順は fs 次第。status の表示と state.json の中身を machine 間で揃えるため key 順にする
  for (const k of names.filter(isMetaKey).sort()) {
    try {
      // 書くときに足した末尾の改行 1 つだけを外す。値は利用者のものなので空白は削らない (保存先との往復で変わらない)
      out.push([k, (await Bun.file(join(dir, META_DIR, k)).text()).replace(/\n$/, "")]);
    } catch (e) {
      // ディレクトリは key ではない。ENOENT (readdir の後に消えた / 先の無い symlink) は値を持たない
      // ものとして数えない (先の無い symlink は push で保存先からも消える。そう決めている)。
      // それ以外 (ELOOP / EACCES 等) は空にせず止める (上と同じ理由)
      if (errCode(e) !== "EISDIR" && errCode(e) !== "ENOENT") throw e;
    }
  }
  return Object.fromEntries(out);
}

const errCode = (e: unknown) => (e && typeof e === "object" && "code" in e ? (e as { code: unknown }).code : undefined);

export async function readDeclared(sessionId: string, home = claudeHome()): Promise<DeclaredState> {
  const dir = sessionDir(sessionId, home);
  const flag = (f: Flag) => Bun.file(join(dir, FLAG_FILE[f])).exists();
  const text = async (name: string) => {
    try {
      return (await Bun.file(join(dir, name)).text()).trim();
    } catch {
      return "";
    }
  };
  const [archived, label, task, heartbeat, metadata, labelHistory] = await Promise.all([
    flag("archived"),
    text(TEXT_FILE.label),
    text(TEXT_FILE.task),
    text(TEXT_FILE.heartbeat),
    readMetadata(dir),
    readLabelHistory(dir),
  ]);
  return { archived, label, task, heartbeat: asHeartbeat(heartbeat), metadata, labelHistory };
}

/**
 * 差分だけ書く。flag は空ファイルの有無、label / task / heartbeat は中身 (空文字なら消す)。
 * metadata は key ごとに、文字列ならその値で置き (空文字は値なし)、null なら消す。
 * label が今と変われば labels.jsonl に 1 行足す。labelHistory を渡したら (pull) 足さずに丸ごと置く。
 * 渡さなかった鍵は触らない。手元で何も変わらない patch (無い key の unset 等) でも
 * `.ccx-declared` は置く: 手元に無い印を保存先の古い写しが持っていることがあり、ここでの
 * クリアはそれを戻さないという宣言だから
 */
export async function writeDeclared(sessionId: string, patch: DeclaredPatch, home = claudeHome()): Promise<DeclaredState> {
  for (const k of Object.keys(patch.metadata ?? {})) if (!isMetaKey(k)) throw new Error(`invalid metadata key ${JSON.stringify(k)}`);
  // 読み手 (readDeclared) は trim した値を返す。ファイルにも履歴にも同じ値を書く: " a " を重ねて記録しない
  if (patch.label !== undefined) patch = { ...patch, label: patch.label.trim() };

  const dir = sessionDir(sessionId, home);
  await mkdir(dir, { recursive: true });
  // 比べる相手は履歴の最後の 1 件 (無ければ今のファイル)。ファイルと比べると、label を書いた後・履歴に足す前に
  // 落ちた変更を次の同じ書き込みが「変わっていない」と読み、二度と記録しない。hook が ccx を通さず書いた名前を
  // ccx で書き直したときも記録される。
  // label と履歴だけを読む: 他 (meta/ 等) が壊れていても label の書き込みは止めない。履歴が読めなければ
  // 履歴には足さない (読めない履歴に続けて書かない。push は同じ読みで止まる)
  const before =
    patch.label !== undefined && patch.labelHistory === undefined
      ? {
          label: (await Bun.file(join(dir, TEXT_FILE.label)).text().catch(() => "")).trim(),
          labelHistory: await readLabelHistory(dir).catch(() => null),
        }
      : undefined;
  // 最初の記録の前に、ccx を通さず付いていた名前 (hook が書いた label) を 1 件目として残す。時刻はそのファイルの mtime
  const seedAt =
    before?.labelHistory && before.label && before.labelHistory.length === 0 && before.label !== patch.label
      ? // 読んだ後に消えていれば (hook と競った) 種は置かない。時刻の無い名前は残さない
        await stat(join(dir, TEXT_FILE.label)).then((s) => s.mtime.toISOString(), () => undefined)
      : undefined;
  await Bun.write(join(dir, DECLARED_FILE), "");
  for (const f of FLAGS) {
    if (patch[f] === undefined) continue;
    const p = join(dir, FLAG_FILE[f]);
    if (patch[f]) await Bun.write(p, "");
    else await rm(p, { force: true });
  }
  for (const k of ["label", "task", "heartbeat"] as const) {
    if (patch[k] === undefined) continue;
    const p = join(dir, TEXT_FILE[k]);
    if (patch[k]) await Bun.write(p, `${patch[k]}\n`);
    else await rm(p, { force: true });
  }
  for (const [k, v] of Object.entries(patch.metadata ?? {})) {
    const p = join(dir, META_DIR, k);
    if (v === null) await rm(p, { force: true });
    else await Bun.write(p, v ? `${v}\n` : "");
  }
  const historyPath = join(dir, LABEL_HISTORY_FILE);
  if (patch.labelHistory !== undefined) {
    const h = cleanLabelHistory(patch.labelHistory);
    if (h.length) {
      // 隣に書いてから rename: 置き換えの途中を読んだ push が、短い履歴を保存先に書かない
      const tmp = `${historyPath}.${randomUUID()}.tmp`;
      try {
        await Bun.write(tmp, h.map((e) => `${JSON.stringify(e)}\n`).join(""));
        await rename(tmp, historyPath);
      } finally {
        await rm(tmp, { force: true });
      }
    } else await rm(historyPath, { force: true });
  } else if (before?.labelHistory && (before.labelHistory.at(-1)?.label ?? before.label) !== patch.label) {
    const lines = [...(seedAt ? [{ at: seedAt, label: before.label }] : []), { at: new Date().toISOString(), label: patch.label! }];
    // 書きかけで切れた行 (改行で終わっていない) に続けて書くと、その行ごと読めなくなる。改行を補ってから足す
    const torn = !(await Bun.file(historyPath).text().catch(() => "")).match(/(^|\n)$/);
    await appendFile(historyPath, `${torn ? "\n" : ""}${lines.map((e) => `${JSON.stringify(e)}\n`).join("")}`);
  }
  return readDeclared(sessionId, home);
}

/** 8-4-4-4-12。Claude Code の session id はこの形 (小文字で書かれる) */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * この machine が、その session の宣言状態を持っているか。宣言を 1 度でも書いた (全部
 * 外した後も含む) か、印が 1 つでもある (label は auto-label hook が ccx を通さず書く) とき。
 * 持っているなら、保存先の写しで上書きも補完もしない
 */
export async function holdsDeclared(sessionId: string, home = claudeHome()): Promise<boolean> {
  if (await Bun.file(join(sessionDir(sessionId, home), DECLARED_FILE)).exists()) return true;
  return !isEmptyDeclared(await readDeclared(sessionId, home));
}

/**
 * 印が 1 つでも立っている session の id (transcript の有無は問わない)。ディレクトリが
 * あるだけでは数えない: 印を外した後や、Claude Code 自身が置くファイル (label の履歴
 * 等) で空のディレクトリが残るため。印が読めない session も含める (prefix 解決の候補として)
 */
export async function markedSessionIds(home = claudeHome()): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(join(home, "sessions"))).filter((n) => UUID.test(n));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of names) {
    try {
      if (!isEmptyDeclared(await readDeclared(id, home))) out.push(id);
    } catch (e) {
      // 1 session の読めない印で他の解決を止めない。ただし候補からは外さない: 外すと曖昧な prefix が
      // 一意に見えて、別の session に書く
      console.error(`(${id}: declared state could not be read — fix ${sessionDir(id, home)}: ${e instanceof Error ? e.message : String(e)})`);
      out.push(id);
    }
  }
  return out;
}

/**
 * 完全な id はそのまま。先頭一致は known の中で一意なときだけ通す。
 * 曖昧なら止まる (別の session に印を付けない)
 */
export function resolveSessionId(idOrPrefix: string, known: Iterable<string>): string {
  // Claude Code の id は小文字。大文字で受けても同じ session を指す (Linux では別のディレクトリになる)
  const q = idOrPrefix.toLowerCase();
  if (UUID.test(q)) return q;
  const hits = [...new Set(known)].filter((id) => id.startsWith(q)).sort();
  if (hits.length === 0) throw new NoLocalSession(idOrPrefix);
  if (hits.length > 1) throw new Error(`${idOrPrefix} matches ${hits.length} sessions: ${hits.join(", ")}`);
  return hits[0]!;
}

export class NoLocalSession extends Error {
  constructor(readonly prefix: string) {
    super(`no local session matches ${prefix}`);
    this.name = "NoLocalSession";
  }
}

