/**
 * repodir を人間に選ばせる。
 *
 * dir-id は人間が読む前提の識別子ではない (機械が採番し、path が identity である以上、
 * 短くも意味的でもない)。だから選択は「何のために作った repodir か」= initialTask を頼りに
 * 行われる必要がある。id を打たせた時点でこの設計は破綻する。
 *
 * picker を自前で持たず fzf に委譲するのは、
 *   - ユーザーが既に持っている fzf の設定 (keybind / layout) がそのまま効く
 *   - ccx が TUI を抱え込まない
 * ため。fzf が無い環境でも使えないと困るので、番号選択にフォールバックする。
 *
 * fzf は UI を /dev/tty に直接描くので、`cd "$(ccx rd cd)"` のように stdout を捕捉されても
 * 画面は壊れない。この性質が、選択結果を stdout に流すという既存規約 (new / rm / gc と同じ)
 * と両立する唯一の理由になっている。
 */

import { createInterface } from "node:readline/promises";
import { createReadStream, createWriteStream, openSync } from "node:fs";

import type { RepodirInfo } from "@ccx/core";

/**
 * 候補行のプロトコルは「1 候補 = 1 行、フィールド区切りは TAB」。initialTask は人間が書いた
 * 自由文なので、改行も TAB も入りうる。そのまま流すと 1 候補が複数行に割れ、TAB は列を増やす
 * ので、選択そのものが壊れる。ここで潰すのは表示の都合ではなくプロトコルの都合。
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** fzf に渡す 1 行。先頭フィールドは dir-id で、表示からは隠す (--with-nth=2..)。 */
export function candidateLine(info: RepodirInfo): string {
  const flags = [
    info.session.active ? "session" : "",
    info.git.dirty ? "dirty" : "",
    info.git.unpushed ? `+${info.git.unpushed}` : "",
    info.state?.done ? "done" : "",
  ].filter(Boolean).join(",");

  const task = info.meta?.initialTask ?? (info.metaError ? `!! ${info.metaError}` : "-");

  return [
    info.dirId,
    `${info.spec.owner}/${info.spec.repo}`,
    oneLine(info.git.branch ?? "-"),
    flags || "-",
    oneLine(task) || "-",
  ].join("\t");
}

/** fzf が返した行を repodir に戻す。表示テキストではなく dir-id で引く。 */
export function resolveSelection(infos: RepodirInfo[], line: string): RepodirInfo | null {
  const dirId = line.split("\t")[0]?.trim();
  if (!dirId) return null;
  return infos.find((i) => i.dirId === dirId) ?? null;
}

/** fzf that isn't there。番号選択に降りるための唯一の条件。 */
class FzfUnavailable extends Error {}

/** fzf に選ばせる。ユーザーが中断したら null。 */
async function pickWithFzf(infos: RepodirInfo[]): Promise<RepodirInfo | null> {
  const input = infos.map(candidateLine).join("\n");

  const spawnFzf = () => {
    try {
      return Bun.spawn(
        [
          "fzf",
          "--delimiter", "\t",
          "--with-nth", "2..",
          "--no-multi",
          "--prompt", "repodir> ",
          "--header", "select a repodir by what it was created for",
        ],
        {
          stdin: new TextEncoder().encode(input),
          stdout: "pipe",
          // fzf は UI を /dev/tty に描く。stderr は素通しでよい。
          stderr: "inherit",
          // env を明示しないと、Bun は起動時に取り込んだ環境で実行ファイルを解決する。PATH を
          // 差し替えても拾われないので毎回渡し直す (config.ts の gitConfig と同じ理由)。
          env: { ...process.env },
        },
      );
    } catch {
      throw new FzfUnavailable();
    }
  };

  const proc = spawnFzf();

  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  // 1 = no match, 130 = ESC / Ctrl-C。どちらも「選ばなかった」であってエラーではない。
  if (code === 1 || code === 130) return null;

  // それ以外 (tty が無くて fzf 自身が死ぬ 2 など) は握り潰さない。黙って null を返すと
  // 「選ばなかった」と区別がつかず、壊れているのに何も起きていないように見える。
  if (code !== 0) throw new Error(`fzf exited with ${code}`);

  return resolveSelection(infos, out.trim());
}

/**
 * 選択 UI の宛先。既定は /dev/tty。
 *
 * stdout は選択結果の path 専用なので、UI で汚してはならない。tty を直に開くのは、
 * `cd "$(ccx rd cd)"` で stdout が捕捉されていても人間には画面が見える必要があるため
 * (fzf が同じことをしている)。テストから差し替えられるように口を開けてある。
 */
export type Tty = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
};

/**
 * /dev/tty を開く。制御端末が無ければ、意図したエラーにして投げる。
 *
 * `createReadStream("/dev/tty")` では駄目だった。あれは open を遅延させるので、端末が無くても
 * 同期的には何も起きず、ENXIO は後から 'error' イベントで飛んでくる。try/catch は素通りし、
 * 未処理の例外として生スタックが吐かれる。fzf も端末も無い環境 (CI / cron / `ssh host cmd` /
 * `docker exec` — つまり並列自動実行というこのツールの本来の用途) はまさにそこを踏む。
 *
 * openSync は同期で throw するので、失敗を掴める場所が open の呼び出し点に戻る。
 */
export function openTty(open: (path: string, flags: string) => number = openSync): Tty {
  let inFd: number;
  let outFd: number;
  try {
    inFd = open("/dev/tty", "r");
    outFd = open("/dev/tty", "w");
  } catch {
    throw new Error("no fzf and no tty: cannot pick a repodir interactively");
  }

  return {
    input: createReadStream("", { fd: inFd }),
    output: createWriteStream("", { fd: outFd }),
  };
}

/** fzf が無い環境用。番号で選ばせる。 */
export async function pickByNumber(infos: RepodirInfo[], tty: Tty = openTty()): Promise<RepodirInfo | null> {
  const rl = createInterface({ input: tty.input, output: tty.output });
  try {
    for (const [n, info] of infos.entries()) {
      const [, repo, branch, flags, task] = candidateLine(info).split("\t");
      tty.output.write(`${String(n + 1).padStart(3)}) ${repo}  ${branch}  ${flags}  ${task}\n`);
    }

    const answer = (await rl.question("select> ")).trim();
    if (!answer) return null;

    const n = Number(answer);
    if (!Number.isInteger(n) || n < 1 || n > infos.length) {
      throw new Error(`not a choice: ${answer}`);
    }
    return infos[n - 1]!;
  } finally {
    rl.close();
  }
}

/**
 * repodir を 1 つ選ばせる。選ばれなければ null。
 *
 * 候補が 1 つしか無いときに picker を出さないのは、選択肢の無い選択を人間に見せないため。
 */
export async function pickRepodir(infos: RepodirInfo[], tty?: Tty): Promise<RepodirInfo | null> {
  if (infos.length === 0) throw new Error("no repodirs");
  if (infos.length === 1) return infos[0]!;

  try {
    return await pickWithFzf(infos);
  } catch (e) {
    if (e instanceof FzfUnavailable) return pickByNumber(infos, tty ?? openTty());
    throw e;
  }
}
