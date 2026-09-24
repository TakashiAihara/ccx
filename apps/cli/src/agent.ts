import { readdir, stat } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ローカルの ccx-agent の状態。ccx は ccx-agent に依存しないので、ここで分かることは
 * すべて「外から見た事実」であって、ccx-agent に問い合わせた答えではない。
 */
export type AgentStatus = {
  socketPath: string;
  /** socket ファイルが在るか。在っても掴んでいるプロセスが死んでいることはある */
  socketPresent: boolean;
  /** 実際に connect できたか。ここが true なら ccx-agent は生きている */
  socketConnectable: boolean;
  spoolDir: string;
  /** center へ未転送の event 数 */
  spooled: number;
  /** ccx-agent に渡せず hook が直接落とした event 数。次の ccx-agent 起動で取り込まれる */
  incoming: number;
  /** hubUrl が URL として読めなかった。「届かない」とは別の状態 */
  hubUrlInvalid?: boolean;
  hubUrl?: string;
  /** hub が未設定なら undefined。設定されていて届かなければ false */
  hubReachable?: boolean;
  /**
   * center がこの手元の token を受けたか (#158)。`/healthz` は token 無しで答えるので、
   * reachable だけでは「全 event が 401 で spool に溜まり続けている」が見えない。
   * 見ているのは ccx CLI の token で、ccx-agent (systemd の環境) の token ではない
   */
  hubTokenAccepted?: boolean;
};

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCX_SOCKET) return env.CCX_SOCKET;
  const runtime = env.XDG_RUNTIME_DIR ?? join("/run/user", String(process.getuid?.() ?? 0));
  return join(runtime, "ccx", "ccx-agent.sock");
}

export function defaultSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCX_SPOOL ?? join(env.CCX_ROOT ?? join(homedir(), ".ccx"), "spool");
}

/**
 * socket に繋げるかどうかで生死を見る。ファイルの存在では見ない。
 *
 * unix socket のファイルは、掴んでいたプロセスが死んでも残る。存在だけで「動いて
 * いる」と読むと、落ちた ccx-agent を生きていると報告することになる。
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

/**
 * ccx-agent が使う拡張子。転送待ちは `.pb`、hook が socket に届かず直接落としたものは
 * `.raw` (apps/agent/internal/collect)。どちらのディレクトリにもロックや書きかけの
 * 一時ファイルが同居するので、拡張子で絞らないと「詰まっている件数」が水増しされる。
 */
const SPOOL_EXT = ".pb";
const INCOMING_EXT = ".raw";

async function countFiles(dir: string, suffix: string): Promise<number> {
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith(suffix)).length;
  } catch {
    // ディレクトリが無いのは「まだ 1 件も来ていない」。エラーではない
    return 0;
  }
}

export async function agentStatus(
  hubUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  token?: string,
): Promise<AgentStatus> {
  const socketPath = defaultSocketPath(env);
  const spoolDir = defaultSpoolDir(env);

  const socketPresent = await stat(socketPath).then(
    (s) => s.isSocket(),
    () => false,
  );

  const [socketConnectable, spooled, incoming] = await Promise.all([
    socketPresent ? connectable(socketPath) : Promise.resolve(false),
    countFiles(spoolDir, SPOOL_EXT),
    countFiles(join(spoolDir, "incoming"), INCOMING_EXT),
  ]);

  // URL の組み立ては fetch の前に同期で走るので、catch の外で throw する。
  // scheme を書き忘れた ("127.0.0.1:8791") だけで status 全体が落ちるのは、
  // 「ccx-agent の状態を見る」という用途に対して過剰。読めなかったことを状態として返す。
  let healthz: URL | undefined;
  let hubUrlInvalid = false;
  if (hubUrl) {
    try {
      healthz = new URL("/healthz", hubUrl);
    } catch {
      hubUrlInvalid = true;
    }
  }

  let hubReachable: boolean | undefined;
  if (healthz) {
    hubReachable = await fetch(healthz, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
  } else if (hubUrlInvalid) {
    hubReachable = false;
  }

  let hubTokenAccepted: boolean | undefined;
  if (healthz && hubReachable) {
    // 最小の認証付き呼び出し。401 だけを「受けなかった」とし、それ以外の失敗は判定しない
    hubTokenAccepted = await fetch(new URL("/ccx.v1.FleetService/ListSessions", healthz), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ limit: 1 }),
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => (r.status === 401 ? false : r.ok ? true : undefined))
      .catch(() => undefined);
  }

  return {
    socketPath,
    socketPresent,
    socketConnectable,
    spoolDir,
    spooled,
    incoming,
    hubUrl,
    hubReachable,
    ...(hubTokenAccepted !== undefined ? { hubTokenAccepted } : {}),
    ...(hubUrlInvalid ? { hubUrlInvalid: true } : {}),
  };
}
