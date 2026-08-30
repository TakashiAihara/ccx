import { readdir, stat } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ローカルの ccxd の状態。ccx は ccxd に依存しないので、ここで分かることは
 * すべて「外から見た事実」であって、ccxd に問い合わせた答えではない。
 */
export type AgentStatus = {
  socketPath: string;
  /** socket ファイルが在るか。在っても掴んでいるプロセスが死んでいることはある */
  socketPresent: boolean;
  /** 実際に connect できたか。ここが true なら ccxd は生きている */
  socketConnectable: boolean;
  spoolDir: string;
  /** center へ未転送の event 数 */
  spooled: number;
  /** ccxd に渡せず hook が直接落とした event 数。次の ccxd 起動で取り込まれる */
  incoming: number;
  hubUrl?: string;
  /** hub が未設定なら undefined。設定されていて届かなければ false */
  hubReachable?: boolean;
};

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCX_SOCKET) return env.CCX_SOCKET;
  const runtime = env.XDG_RUNTIME_DIR ?? join("/run/user", String(process.getuid?.() ?? 0));
  return join(runtime, "ccx", "ccxd.sock");
}

export function defaultSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCX_SPOOL ?? join(env.CCX_ROOT ?? join(homedir(), ".ccx"), "spool");
}

/**
 * socket に繋げるかどうかで生死を見る。ファイルの存在では見ない。
 *
 * unix socket のファイルは、掴んでいたプロセスが死んでも残る。存在だけで「動いて
 * いる」と読むと、落ちた ccxd を生きていると報告することになる。
 */
async function connectable(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function countFiles(dir: string, suffix?: string): Promise<number> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => (suffix ? n.endsWith(suffix) : true)).length;
  } catch {
    // ディレクトリが無いのは「まだ 1 件も来ていない」。エラーではない
    return 0;
  }
}

export async function agentStatus(
  hubUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentStatus> {
  const socketPath = defaultSocketPath(env);
  const spoolDir = defaultSpoolDir(env);

  const socketPresent = await stat(socketPath).then(
    (s) => s.isSocket(),
    () => false,
  );

  const [socketConnectable, spooled, incoming] = await Promise.all([
    socketPresent ? connectable(socketPath) : Promise.resolve(false),
    countFiles(spoolDir, ".pb"),
    countFiles(join(spoolDir, "incoming")),
  ]);

  let hubReachable: boolean | undefined;
  if (hubUrl) {
    hubReachable = await fetch(new URL("/healthz", hubUrl), {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => r.ok)
      .catch(() => false);
  }

  return { socketPath, socketPresent, socketConnectable, spoolDir, spooled, incoming, hubUrl, hubReachable };
}
