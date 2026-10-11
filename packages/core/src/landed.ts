/**
 * 未 push の commit の中身が、上流に既に入っているか (#220)。
 *
 * squash merge の repo では、merge 済みのブランチの commit もどの remote ref にも届かず
 * 「未 push」に見える。forge に頼らず git だけで次の順に確かめる:
 *   1. 比べる remote ref (origin/HEAD と起点ブランチ) の先が HEAD そのもの
 *   2. 比べる ref に対して、patch が欠けている commit が無い (git cherry)
 *   3. 未 push の commit が触った各ファイルについて、手元の中身 (blob) が、分岐点より後の比べる ref の
 *      履歴で同じパスに現れる (消したファイルは ref の先にも無い)。パスと分岐点で絞らないと、古い版への
 *      戻し・空のファイル・他のファイルの写しが「入っている」に見える
 * commit の件名は使わない (stacked branch では全部外れる)。消してよいかは決めない: 判断材料を出すだけ
 */

import { git } from "./git.ts";

export type Landed =
  | { landed: true; how: string }
  | { landed: false; how: string; missing: string[] };

const lines = (s: string) => s.split("\n").filter((l) => l !== "");

/** 比べる remote ref。origin/HEAD の先と、repodir を作った起点ブランチ (あれば) */
async function candidates(path: string, baseBranch?: string): Promise<string[]> {
  const out: string[] = [];
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path).catch(() => "");
  if (head) out.push(head);
  if (baseBranch) out.push(`origin/${baseBranch}`);
  const exists = await Promise.all(
    [...new Set(out)].map(async (r) => ((await git(["rev-parse", "--verify", "--quiet", `${r}^{commit}`], path).catch(() => "")) ? r : "")),
  );
  return exists.filter((r) => r !== "");
}

export type LandedOptions = {
  /** repodir を作った起点ブランチ (ccx.json の baseBranch) */
  baseBranch?: string;
  /**
   * repodir の bare mirror と、その default branch。repodir の origin/* は clone した時点のままなので、
   * その後に入った squash merge は mirror の方にしか無い。中身 (blob) の照合にだけ使う
   */
  mirror?: { path: string; branch: string };
};

export async function unpushedLanded(path: string, opts: LandedOptions = {}): Promise<Landed> {
  const { baseBranch, mirror } = opts;
  const refs = await candidates(path, baseBranch);
  if (refs.length === 0) return { landed: false, how: "no remote branch to compare with", missing: [] };

  const head = await git(["rev-parse", "HEAD"], path);
  for (const ref of refs) {
    // 比べる ref だけを見る。別の remote ブランチ (origin/wip 等) に push してあるのは、入ったのではない
    if ((await git(["rev-parse", ref], path)) === head) return { landed: true, how: `${ref} is at HEAD` };
  }

  for (const ref of refs) {
    const unique = lines(await git(["cherry", ref, "HEAD"], path)).filter((l) => l.startsWith("+"));
    if (unique.length === 0) return { landed: true, how: `every commit's patch is in ${ref}` };
  }

  // -z: パスを引用符で囲ませない (core.quotePath)。--no-renames: 改名は消したパスと足したパスの 2 つとして見る
  // 分岐点は repodir の ref で取る。mirror は repodir の元なので、その commit を持っている
  const base = await git(["merge-base", "HEAD", refs[0]!], path);
  // 見るのは分岐点から後の commit が触ったファイル。別の remote ブランチに push 済みでも、比べる ref に
  // 入っていなければ自分の作業として数える
  const nul = (s: string) => s.split("\0").filter((l) => l !== "");
  const files = [...new Set(nul(await git(["log", "-z", "--no-renames", "--format=", "--name-only", `${base}..HEAD`], path)))];
  const inHead = new Set(nul(await git(["ls-tree", "-z", "-r", "--name-only", "HEAD", "--", ...files], path)));
  const blobs = await Promise.all(files.map((f) => (inHead.has(f) ? git(["rev-parse", `HEAD:${f}`], path) : Promise.resolve(""))));
  const targets = refs.map((ref) => ({ cwd: path, ref, name: ref }));
  // repodir が mirror を通さず fetch していると、分岐点を mirror が持っていない。そのときは mirror を見ない
  const mirrorHasBase = mirror && (await git(["cat-file", "-e", `${base}^{commit}`], mirror.path).then(() => true, () => false));
  if (mirror && mirrorHasBase) targets.push({ cwd: mirror.path, ref: mirror.branch, name: `the mirror's ${mirror.branch}` });
  let best: { name: string; missing: string[] } | null = null;
  for (const t of targets) {
    const missing: string[] = [];
    for (const [i, f] of files.entries()) {
      const blob = blobs[i];
      if (!blob) {
        // 手元で消したファイル: ref の先にも無ければ入っている
        const there = await git(["cat-file", "-e", `${t.ref}:${f}`], t.cwd).then(
          () => true,
          () => false,
        );
        if (there) missing.push(f);
        continue;
      }
      const seen = await git(["log", `${base}..${t.ref}`, "-1", "--format=%H", `--find-object=${blob}`, "--", f], t.cwd);
      if (!seen) missing.push(f);
    }
    if (missing.length === 0) return { landed: true, how: `every changed file's content reached ${t.name} after the branch point` };
    if (!best || missing.length < best.missing.length) best = { name: t.name, missing };
  }
  return { landed: false, how: `not in ${best!.name}`, missing: best!.missing };
}
