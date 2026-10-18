/**
 * `ccx session resume` の手元の部分 (#261、docs/design/resume.md): transcript が手元にあるのに止まっている
 * session を、その transcript が記録する cwd に herdr の workspace を作って開き直す。
 *
 * 判断は workspace を作る前に済ませる。作りかけてから止めると、ユーザーは自分の指示では
 * 選ばなかった workspace を放置することになる。exit code で分けるのは、workspace が残って
 * いるか (後始末が要るか) を呼び手が読み分けられるようにするため:
 *   1 = 開く前に止まった。何も作っていない
 *   4 = workspace は作った (か、作られたかもしれない) が、agent として上がったことを確認できなかった
 *   5 = 別のマシンへ依頼は置いたが、待つあいだに結果が届かなかった
 * 3 を使わないのは、`ccx session` の他のコマンドで 3 が「center が設定されていない」(何も起きていない) だから。
 *
 * herdr への命令は外から渡す runner にする。返答の形は herdr の書式に結びついているので、
 * 「どの引数を送り、どの返答をどこから読む」までをこのファイルの境界として持つ。
 */

import type { Command } from "commander";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  claudeHome,
  findLocalTranscript,
  loadConfig,
  localOrigin,
  localTranscripts,
  readDeclared,
  resolveSessionId,
  runningSessionIds,
  transcriptFacts,
  UUID,
  type Config,
  type Origin,
} from "@ccx/core";

import { createClient } from "@connectrpc/connect";

import { toJson } from "@bufbuild/protobuf";

import { ResumeRequestSchema, ResumeService, type ResumeRequest } from "@ccx/proto/ccx/v1/resume_pb.ts";

import { centerTransport, NoCenterConfigured, unreachable } from "./fleet.ts";
import { resumeRemote } from "./resume-remote.ts";

export type HerdrResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export type Herdr = (args: string[]) => Promise<HerdrResult>;

export type Created = { workspaceId: string; paneId: string };

/**
 * 開けなかった理由。exitCode はどこまで進んだか
 * (1 = 作っていない、4 = workspace が残っている、5 = 別のマシンへの依頼の結果が届いていない)
 */
export class ResumeError extends Error {
  readonly exitCode: 1 | 4 | 5;
  /** exitCode 4 で、workspace の id が読めていればそれ (後始末に使う) */
  readonly created?: Created;

  constructor(message: string, exitCode: 1 | 4 | 5, created?: Created) {
    super(message);
    this.name = "ResumeError";
    this.exitCode = exitCode;
    this.created = created;
  }
}

const PLACEHOLDER = "{session_id}";

/** `{session_id}` を id に置き換える。id は UUID に限ってから渡すので、置き換えた結果に記号は増えない */
export const expandCommand = (template: string, sessionId: string): string => template.split(PLACEHOLDER).join(sessionId);

/** 宣言された label を添えるときの長さ。自由文なので、cwd を見失わない範囲で切る */
const LABEL_LIMIT = 24;

export type ResumeOptions = {
  /** 完全な session id。先頭一致は呼び手が解く */
  sessionId: string;
  /** ~/.claude */
  home: string;
  /** pane で走らせるコマンドの雛形 (`{session_id}` がプレースホルダ) */
  command: string;
  herdr: Herdr;
  /** pane の agent がこの名前で stableMs 続いたら上がったとみなす (既定 claude) */
  agent?: string;
  /** agent が途切れずに見え続けるべき時間 (既定 5 秒) */
  stableMs?: number;
  /** archived でも開けるようにする */
  force?: boolean;
  /** agent が上がるのを待つ時間 (既定 40 秒) */
  waitMs?: number;
  /** 待つあいだの間隔 (既定 1 秒) */
  pollMs?: number;
};

export type ResumeResult = Created & { cwd: string; label: string };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** herdr の応答から 1 つの値を辿る。読めない JSON、辿れない途中、空文字は null */
function dig(stdout: string, ...keys: string[]): string | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  for (const k of keys) {
    if (!v || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[k];
  }
  return typeof v === "string" && v ? v : null;
}

/** herdr の stderr。無ければ stdout、空は何も言っていないことを表す */
const said = (r: { stdout: string; stderr: string }) => r.stderr.trim() || r.stdout.trim() || "(no output)";

const lastLines = (s: string, lines: number) => s.trim().split("\n").slice(-lines).join("\n");

/**
 * workspace の label。cwd の末尾だけではどの session かが分からないので、宣言された label を
 * 添える。改行や連続した空白は 1 つの空白にする (label は 1 行で出る)。全角の縦棒は、label が
 * 先頭以外にあることを読み手が目で分かるようにするため
 */
function labelFor(cwd: string, declared: string): string {
  const dir = basename(cwd);
  const text = [...declared.replace(/\s+/g, " ").trim()].slice(0, LABEL_LIMIT).join("").trimEnd();
  return text ? `${dir}｜${text}` : dir;
}

const closeHint = (c: Created) => `close it with: herdr workspace close ${c.workspaceId}`;

export async function resumeSession(o: ResumeOptions): Promise<ResumeResult> {
  const waitMs = o.waitMs ?? 40_000;
  const pollMs = o.pollMs ?? 1_000;
  const agent = o.agent ?? "claude";
  const stableMs = o.stableMs ?? STABLE_MS;

  // Claude Code の id は小文字。大文字のままでは transcript を見つけられない
  const id = o.sessionId.toLowerCase();
  if (!UUID.test(id)) throw new ResumeError(`not a session id: ${o.sessionId}`, 1);
  // id の入らないコマンドは別の session を開くか何も開かないので、workspace を作る前に止める
  if (!o.command.includes(PLACEHOLDER)) {
    throw new ResumeError(`the resume command ${JSON.stringify(o.command)} has no ${PLACEHOLDER}; set [resume] command to one that does`, 1);
  }

  if ((await runningSessionIds(o.home)).has(id)) {
    throw new ResumeError(`${id} is running on this machine; there is nothing to reopen`, 1);
  }
  const declared = await readDeclared(id, o.home);
  if (declared.archived && !o.force) {
    throw new ResumeError(`${id} is archived — pass --force to open it anyway`, 1);
  }
  const path = await findLocalTranscript(id, o.home);
  if (!path) {
    throw new ResumeError(`no local transcript for ${id} under ${o.home}/projects — pull it from the store first`, 1);
  }
  const cwd = (await transcriptFacts(path)).cwd;
  if (!cwd) {
    throw new ResumeError(`${id}'s transcript records no cwd, so there is no directory to open it in`, 1);
  }
  // repodir は gc で消える。消えた cwd の代わりの場所で開くと、session は走っていなかった場所で続くことになる
  const dir = await stat(cwd).catch(() => null);
  if (!dir?.isDirectory()) {
    throw new ResumeError(`${id} ran in ${cwd}, which is no longer a directory here`, 1);
  }
  const label = labelFor(cwd, declared.label);

  const createdRes = await o.herdr(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  if (createdRes.timedOut) {
    throw new ResumeError(`herdr workspace create did not answer in time; a workspace may have been created (check herdr workspace list)`, 4);
  }
  if (createdRes.code !== 0) throw new ResumeError(`herdr workspace create failed: ${said(createdRes)}`, 1);
  const workspaceId = dig(createdRes.stdout, "result", "workspace", "workspace_id");
  const paneId = dig(createdRes.stdout, "result", "root_pane", "pane_id");
  if (!workspaceId || !paneId) {
    // create は成功したと言っているので、workspace は在ると見る
    throw new ResumeError(
      `herdr workspace create succeeded but its answer has no workspace id and pane id, so a workspace is likely left (check herdr workspace list): ${said(createdRes)}`,
      4,
    );
  }
  const created = { workspaceId, paneId };

  // 1 引数で渡す。herdr に shell と同じ分解をさせないぶん、コマンドの中の記号の意味は
  // 利用者が書いたままになる
  const command = expandCommand(o.command, id);
  const ran = await o.herdr(["pane", "run", paneId, command]);
  if (ran.code !== 0) {
    throw new ResumeError(`workspace ${workspaceId} was created, but herdr pane run failed: ${said(ran)}\n${closeHint(created)}`, 4, created);
  }

  // 見えた瞬間ではなく、途切れずに stableMs 見え続けたら上がったとみなす (STABLE_MS)。
  // 締め切りの時点で見えていれば、続くか途切れるかが分かるまで待つ
  const deadline = Date.now() + waitMs;
  let seen = 0;
  let since = 0;
  for (;;) {
    const got = await o.herdr(["pane", "get", paneId]);
    // 答えられなかった回は「上がっていない」とは数えない。見えていた並びを切らず、増やしもしない
    if (got.code === 0) {
      const up = dig(got.stdout, "result", "pane", "agent") === agent;
      if (!up) seen = 0;
      else if (seen++ === 0) since = Date.now();
    }
    if (seen >= 2 && Date.now() - since >= stableMs) return { ...created, cwd, label };
    // 締め切りの後に待つのは、見えている並びが続くかを確かめる stableMs と確かめの 1 回までで打ち切る
    // (herdr が答えない間も終わる)
    if (Date.now() >= deadline && (seen === 0 || Date.now() >= deadline + stableMs + pollMs)) break;
    await sleep(pollMs);
  }

  const shown = await o.herdr(["pane", "read", paneId, "--source", "visible"]);
  const visible = shown.code === 0 ? lastLines(shown.stdout, 20) : "";
  throw new ResumeError(
    [
      `workspace ${workspaceId} was created and ${command} was run in ${paneId}, but the pane did not keep reporting agent=${agent} for ${stableMs} ms within the ${waitMs} ms wait`,
      shown.code === 0 ? (visible ? `what the pane shows:\n${visible}` : "") : `the pane could not be read: ${said(shown)}`,
      closeHint(created),
    ]
      .filter(Boolean)
      .join("\n\n"),
    4,
    created,
  );
}

/**
 * agent が見え続けるべき時間。d1 で存在しない id を `claude --resume` したところ、pane は約 1.5〜2 秒
 * agent=claude を報告してから shell に戻った (2 回測った)。その 2 倍を超える長さにして、すぐ終わる
 * 起動を上がったと読まない
 */
export const STABLE_MS = 5_000;

/** 1 回の herdr の呼び出しの上限。止まった herdr で resume ごと止まらないようにする */
const HERDR_TIMEOUT_MS = 15_000;

/**
 * 起動できなければ code 127 (shell が「無い」に返すのと同じ値) と理由を返す。呼び手が段階ごとに exit code を決める。
 * 時間切れは自分のタイマーで決める: 子が TERM を握っても止まるよう直接の子に SIGKILL を送り、出力の読み取りを
 * 打ち切って返す。子が残した孫 (stdout を持ったまま) までは止めないが、resume はそれを待たない
 */
export async function runHerdr(args: string[], timeoutMs = HERDR_TIMEOUT_MS, bin = "herdr"): Promise<HerdrResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { code: 127, stdout: "", stderr: `herdr is needed to open a session, and it could not be run: ${e instanceof Error ? e.message : String(e)}` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HerdrResult>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      void (proc.stdout as ReadableStream).cancel().catch(() => {});
      void (proc.stderr as ReadableStream).cancel().catch(() => {});
      resolve({ code: 137, stdout: "", stderr: `herdr ${args.slice(0, 2).join(" ")} did not answer within ${timeoutMs} ms`, timedOut: true });
    }, timeoutMs);
  });
  const done = Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]): HerdrResult => ({ code, stdout, stderr }));
  try {
    return await Promise.race([done, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** 1 時間を超える待ちは打ち間違いとみなす (1e306 秒は Infinity ms になり、永久に待つ) */
const parseWait = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 3600) throw new Error(`--wait must be a number of seconds in (0, 3600]: ${v}`);
  return n * 1000;
};

type ResumeFlags = { force?: boolean; machine?: string; user?: string; wait?: number; json?: boolean };

/**
 * 依頼を置き、その session のあるマシンの ccx-agent に開いてもらう。返るのは開いた依頼そのもの
 *
 * 先頭一致は解かない。他のマシンの transcript はこのマシンに無いので、候補を探す対象が無い
 */
async function resumeElsewhere(cfg: Config, me: Origin, idOrPrefix: string, o: ResumeFlags): Promise<ResumeRequest> {
  const hub = cfg.hub;
  if (!hub) throw new NoCenterConfigured();
  const sessionId = idOrPrefix.toLowerCase();
  if (!UUID.test(sessionId)) {
    throw new ResumeError(`${idOrPrefix} is not a full session id; another machine's session is named only by its full id (a prefix is resolved from this machine's transcripts)`, 1);
  }
  try {
    return await resumeRemote({
      center: createClient(ResumeService, centerTransport(hub)),
      key: { machine: o.machine ?? cfg.machine, user: o.user ?? me.user, sessionId },
      force: Boolean(o.force),
      // 相手の ccx-agent が取りに来るまでの数秒と、相手が agent を待つ時間を足す
      waitMs: (o.wait ?? 40_000) + 60_000,
    });
  } catch (e) {
    // 開けなかった (ResumeError) のは相手の話、届かなかったのは center の話。混ぜない
    if (e instanceof ResumeError) throw e;
    throw unreachable(hub.url, e);
  }
}

/**
 * 手元ではなく、別のマシン (または別のユーザー) に開いてもらうか。machine か user のどちらかが
 * 名指しされていて、その origin が手元と違うなら別。名指しされていなければ手元 (前と同じ)
 */
export function isRemote(o: { machine?: string; user?: string }, me: { machine: string; user: string }): boolean {
  if (o.machine && o.machine !== me.machine) return true;
  return Boolean(o.user && o.user !== me.user);
}

export function registerResume(session: Command): void {
  session
    .command("resume")
    .description("Open a stopped session again in a herdr workspace, on the cwd its transcript records — here, or on another machine or user through the center")
    .argument("<session-id>", "session id, or a unique prefix of one with a transcript here (another machine takes only a full id)")
    .option("-f, --force", "open it even if it is archived")
    .option("-m, --machine <name>", "have that machine's ccx-agent open it there, through the center (default: here)")
    .option("-u, --user <name>", "have that user's ccx-agent open it, through the center (with -m, or alone on this machine)")
    .option("--wait <seconds>", "how long to wait for the agent to come up (default 40)", parseWait)
    .option("--json", "print the result (or the failure) as JSON")
    .action(async (idOrPrefix: string, o: ResumeFlags) => {
      const home = claudeHome();
      try {
        const cfg = await loadConfig();
        const me = localOrigin(cfg.machine);
        if (isRemote({ machine: o.machine, user: o.user }, me)) {
          const asked = await resumeElsewhere(cfg, me, idOrPrefix, o);
          // proto の JSON の形で出す (生成物の内部の欄 `$typeName` と、Timestamp の seconds / nanos の分解を出さない)
          if (o.json) console.log(JSON.stringify(toJson(ResumeRequestSchema, asked), null, 2));
          else console.log(`opened on ${asked.key?.machine}: ${asked.detail}`);
          return;
        }
        const known = UUID.test(idOrPrefix.toLowerCase()) ? [] : (await localTranscripts(home)).map((t) => t.sessionId);
        let sessionId: string;
        try {
          sessionId = resolveSessionId(idOrPrefix, known);
        } catch (e) {
          throw new ResumeError(e instanceof Error ? e.message : String(e), 1);
        }
        const r = await resumeSession({
          sessionId,
          home,
          command: cfg.resume.command,
          herdr: (args) => runHerdr(args),
          agent: cfg.resume.agent,
          force: Boolean(o.force),
          waitMs: o.wait,
        });
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else console.log(`opened ${r.workspaceId} pane=${r.paneId} ${r.label} (${r.cwd})`);
      } catch (e) {
        if (!(e instanceof ResumeError)) {
          // 他のコマンドと同じく index.ts が stderr と exit code を受け持つ。--json の読み手には失敗の形だけを渡す
          if (o.json) {
            const exitCode = e instanceof NoCenterConfigured ? 3 : 1;
            console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e), exitCode }, null, 2));
          }
          throw e;
        }
        if (o.json) console.log(JSON.stringify({ error: e.message, exitCode: e.exitCode, ...e.created }, null, 2));
        console.error(e.message);
        process.exitCode = e.exitCode;
      }
    });
}
