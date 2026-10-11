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
 * commit の件名は使わない (stacked branch では全部外れる)。消してよいかは決めない: 判断材料を出すだけ。
 * 上流に入った後で上流が戻したものも「入っている」と答える (中身は上流の履歴から取り戻せる)。
 * 比べる ref との分岐点が 1 つに決まらない (develop から切ったブランチに main を merge した等) ときは、
 * 入っていないと答える (安全側。その repodir は gc に残る)。ファイルが分岐点と同じなら「入っている」と答える:
 * 途中の commit (別の remote ブランチに push したものを含む) が何をしていても、手元の中身はすべて分岐点にある
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

  // 分岐点は 1 つ: 比べる ref との merge-base のうち一番新しいもの (他がすべてその祖先)。古い分岐点で比べると、
  // 起点ブランチ (develop 等) にだけある変更を戻したものが「変化なし」や「入っている」に見える
  const isAncestor = (a: string, b: string, cwd = path) =>
    git(["merge-base", "--is-ancestor", a, b], cwd).then(
      () => true,
      () => false,
    );
  const bases = (await Promise.all(refs.map((ref) => git(["merge-base", "HEAD", ref], path).catch(() => "")))).filter((b) => b);
  let base = "";
  for (const b of bases) if ((await Promise.all(bases.map((o) => isAncestor(o, b)))).every(Boolean)) base = b;
  if (!base) return { landed: false, how: "no single branch point with the compared refs", missing: [] };

  const targets: { cwd: string; ref: string; name: string; base: string }[] = [];
  // 分岐点を含む ref とだけ比べる。含まない ref (develop から切ったときの origin/main) の base..ref は、その ref
  // 自身の分岐点からの履歴を全部含むので、backport や develop にだけあるファイルの削除が「入っている」に見える
  for (const ref of refs) if (await isAncestor(base, ref)) targets.push({ cwd: path, ref, name: ref, base });
  if (mirror) {
    // mirror でも起点ブランチを見る (あれば)。repodir が mirror を通さず fetch していて分岐点を mirror が
    // 持っていなければ、mirror は見ない
    const branch = baseBranch && (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`], mirror.path).catch(() => "")) ? baseBranch : mirror.branch;
    const has = await git(["cat-file", "-e", `${base}^{commit}`], mirror.path).then(() => true, () => false);
    if (has && (await isAncestor(base, branch, mirror.path))) {
      targets.push({ cwd: mirror.path, ref: branch, name: `the mirror's ${branch}`, base });
    }
  }

  for (const t of targets.filter((t) => t.cwd === path && t.base)) {
    // git cherry は merge commit を見ない。merge が独自の変更を持ちうるので、merge を含むなら使わない
    if (await git(["rev-list", "--merges", "-1", `${t.base}..HEAD`], path)) continue;
    const unique = lines(await git(["cherry", t.ref, "HEAD"], path)).filter((l) => l.startsWith("+"));
    if (unique.length === 0) return { landed: true, how: `every commit's patch is in ${t.ref}` };
  }

  // -z: パスを引用符で囲ませない (core.quotePath)。--no-renames: 改名は消したパスと足したパスの 2 つとして見る。
  // 分岐点と HEAD の差で取るので、merge が持ち込んだ変更も入り、足して消しただけのファイルは入らない
  const nul = (s: string) => s.split("\0").filter((l) => l !== "");
  const blobOf = new Map<string, string>();
  let best: { name: string; missing: string[] } | null = null;
  for (const t of targets.filter((t) => t.base)) {
    const files = nul(await git(["diff", "-z", "--no-renames", "--name-only", t.base, "HEAD"], path));
    if (files.length === 0) return { landed: true, how: `the files are the same as at the branch point on ${t.name}` };
    const missing: string[] = [];
    for (const f of files) {
      if (!blobOf.has(f)) {
        const inHead = (await git(["ls-tree", "-z", "--name-only", "HEAD", "--", f], path)) !== "";
        blobOf.set(f, inHead ? await git(["rev-parse", `HEAD:${f}`], path) : "");
      }
      const blob = blobOf.get(f)!;
      if (!blob) {
        // 手元で消したファイル: ref の先にも無ければ入っている
        const there = await git(["cat-file", "-e", `${t.ref}:${f}`], t.cwd).then(
          () => true,
          () => false,
        );
        if (there) missing.push(f);
        continue;
      }
      const seen = await git(["log", `${t.base}..${t.ref}`, "-1", "--format=%H", `--find-object=${blob}`, "--", f], t.cwd);
      if (!seen) missing.push(f);
    }
    if (missing.length === 0) return { landed: true, how: `every changed file's content reached ${t.name} after the branch point` };
    if (!best || missing.length < best.missing.length) best = { name: t.name, missing };
  }
  if (!best) return { landed: false, how: "no branch point with any compared ref", missing: [] };
  return { landed: false, how: `not in ${best.name}`, missing: best.missing };
}
