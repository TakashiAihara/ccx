/** git の薄いラッパ。cd せず必ず -C を使う。 */

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${code})\n${stderr.trim()}`);
    this.name = "GitError";
  }
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const argv = cwd ? ["git", "-C", cwd, ...args] : ["git", ...args];

  // env を明示的に渡す。Bun.spawn は既定では起動時の環境を使うため、実行中に
  // process.env を変更しても子プロセスに伝播しない (GIT_CONFIG_GLOBAL 等が効かない)。
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env } });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) throw new GitError(argv.slice(1), code, stderr);
  return stdout.trim();
}

/** リモートの default branch (HEAD が指す先) を得る。 */
export async function defaultBranch(gitDir: string): Promise<string> {
  try {
    const head = await git(["symbolic-ref", "--short", "HEAD"], gitDir);
    if (head) return head;
  } catch {
    // bare mirror で HEAD が未設定のケース
  }
  const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], gitDir);
  return ref.replace(/^origin\//, "");
}

export const revParse = (ref: string, cwd: string) => git(["rev-parse", ref], cwd);
