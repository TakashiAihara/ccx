/**
 * `ccx session resume` の手元の部分 (#261): transcript が手元にあるのに止まっている session を、
 * その transcript が記録する cwd に herdr の workspace を作って開き直す。
 *
 * 判断は workspace を作る前に済ませる。作りかけてから止めると、ユーザーは自分の指示では
 * 選ばなかった workspace を放置することになる。exit code で分けるのは、workspace が残って
 * いるか (後始末が要るか) を呼び手が読み分けられるようにするため:
 *   1 = 開く前に止まった。何も作っていない
 *   3 = workspace は作ったが、agent として上がったことを確認できなかった
 *
 * herdr への命令は外から渡す runner にする。返答の形は herdr の書式に結びついているので、
 * 「どの引数を送り、どの返答をどこから読む」までをこのファイルの境界として持つ。
 */

import type { Command } from "commander";
import { basename } from "node:path";

import { claudeHome, loadConfig, localTranscripts, readDeclared, runningSessionIds, transcriptFacts, UUID } from "@ccx/core";

export type Herdr = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 開かなかった理由。exitCode はどこまで進んだか (1 = 作っていない、3 = workspace はある) */
export class ResumeRefused extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: 1 | 3) {
    super(message);
    this.name = "ResumeRefused";
    this.exitCode = exitCode;
  }
}

/**
 * `{session_id}` を id に置き換える。replace の第 2 引数に文字列を渡すと `$&` や `$1` が
 * 置換文字列の中身として展開されてしまうので、切り貼りだけにする
 */
export const expandCommand = (template: string, sessionId: string): string =>
  template.split("{session_id}").join(sessionId);

/** 宣言された label を添えるときの長さ。自由文なので、cwd を見失わない範囲で切る */
const LABEL_LIMIT = 24;

export type ResumeOptions = {
  sessionId: string;
  /** ~/.claude */
  home: string;
  /** pane で走らせるコマンドの雛形 (`{session_id}` がプレースホルダ) */
  command: string;
  herdr: Herdr;
  /** archived でも開けるようにする */
  force?: boolean;
  /** agent が上がるのを待つ時間 (既定 40 秒) */
  waitMs?: number;
  /** 待つあいだの間隔 (既定 1 秒) */
  pollMs?: number;
};

export type ResumeResult = { workspaceId: string; paneId: string; cwd: string; label: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * herdr の応答から 1 つの値を辿る。読めない JSON、辿れない途中、空文字は null。
 * 「読めなかった」を空文字や 0 として返すと、開いていない workspace を次の pane まで進めてしまう
 */
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
 * 添える。全角の縦棒は、label が先頭以外にあることを読み手が目で分かるようにするため
 */
function labelFor(cwd: string, declared: string): string {
  const dir = basename(cwd);
  if (!declared) return dir;
  return `${dir}｜${[...declared].slice(0, LABEL_LIMIT).join("").trimEnd()}`;
}

export async function resumeSession(o: ResumeOptions): Promise<ResumeResult> {
  const waitMs = o.waitMs ?? 40_000;
  const pollMs = o.pollMs ?? 1_000;

  // Claude Code の id は小文字。大文字のままでは transcript を見つけられない
  const id = o.sessionId.toLowerCase();
  if (!UUID.test(id)) throw new Error(`not a session id: ${o.sessionId}`);

  if ((await runningSessionIds(o.home)).has(id)) {
    throw new ResumeRefused(`${id} is running on this machine; there is nothing to reopen`, 1);
  }
  const declared = await readDeclared(id, o.home);
  if (declared.archived && !o.force) {
    throw new ResumeRefused(`${id} is archived — pass --force to open it anyway`, 1);
  }
  const t = (await localTranscripts(o.home)).find((x) => x.sessionId === id);
  if (!t) {
    throw new ResumeRefused(`no local transcript for ${id} under ${o.home}/projects — pull it from the store first`, 1);
  }
  // cwd は transcript が記録しているもの。宣言された状態には無い
  const cwd = (await transcriptFacts(t.path)).cwd;
  if (!cwd) {
    throw new ResumeRefused(`${id}'s transcript records no cwd, so there is no directory to open it in`, 1);
  }
  const label = labelFor(cwd, declared.label);

  const created = await o.herdr(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  if (created.code !== 0) throw new ResumeRefused(`herdr workspace create failed: ${said(created)}`, 1);
  const workspaceId = dig(created.stdout, "result", "workspace", "workspace_id");
  const paneId = dig(created.stdout, "result", "root_pane", "pane_id");
  if (!workspaceId || !paneId) {
    throw new ResumeRefused(`herdr workspace create answered without a workspace id and pane id: ${said(created)}`, 1);
  }

  // 1 引数で渡す。herdr に shell と同じ分解をさせないぶん、コマンドの中の記号の意味は
  // 利用者が書いたままになる
  const command = expandCommand(o.command, id);
  const ran = await o.herdr(["pane", "run", paneId, command]);
  if (ran.code !== 0) {
    throw new ResumeRefused(`workspace ${workspaceId} was created, but herdr pane run failed: ${said(ran)}`, 3);
  }

  // agent として上がったことは pane の情報でしか分からない。上がらないまま成功を返すと
  // 開けたことにされるので、見えているものを添えて 3 で止める
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = await o.herdr(["pane", "get", paneId]);
    if (got.code === 0 && dig(got.stdout, "result", "pane", "agent") === "claude") {
      return { workspaceId, paneId, cwd, label };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  const shown = await o.herdr(["pane", "read", paneId, "--source", "visible"]);
  const seen = lastLines(shown.code === 0 ? shown.stdout : shown.stderr, 20);
  throw new ResumeRefused(
    [
      `workspace ${workspaceId} was created and ${command} was run in ${paneId}, but the pane did not report agent=claude within ${waitMs} ms`,
      seen ? `what the pane shows:\n${seen}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    3,
  );
}

/** PATH に無ければ Bun.spawn が例外を投げる。握り潰さず、開かなかった理由として残す */
async function runHerdr(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["herdr", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    throw new ResumeRefused(
      `herdr is needed to open a session, and it could not be run: ${e instanceof Error ? e.message : String(e)}`,
      1,
    );
  }
}

export function registerResume(session: Command): void {
  session
    .command("resume")
    .description("Open a stopped session again in a herdr workspace, on the cwd its transcript records")
    .argument("<session-id>", "session id (full, as printed by --json)")
    .option("-f, --force", "open it even if it is archived")
    .option("--json", "print the result as JSON")
    .action(async (sessionId: string, o) => {
      const cfg = await loadConfig();
      try {
        const r = await resumeSession({
          sessionId,
          home: claudeHome(),
          command: cfg.resume.command,
          herdr: runHerdr,
          force: Boolean(o.force),
        });
        if (o.json) console.log(JSON.stringify(r, null, 2));
        else console.log(`opened ${r.workspaceId} pane=${r.paneId} ${r.label} (${r.cwd})`);
      } catch (e) {
        // 拒否だけが持つ code を持って、それ以外はこのまま投げ直す。他のコマンドと
        // 同じ扱い (parseAsync が message を出して 1 で終わる) になる
        if (!(e instanceof ResumeRefused)) throw e;
        console.error(e.message);
        process.exitCode = e.exitCode;
      }
    });
}