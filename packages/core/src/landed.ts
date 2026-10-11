/**
 * 未 push の commit の中身が、上流に既に入っているか (#220)。
 *
 * squash merge の repo では、merge 済みのブランチの commit もどの remote ref にも届かず
 * 「未 push」に見える。forge に頼らず git だけで次の順に確かめる:
 *   1. HEAD を指す remote ref がある
 *   2. 比べる remote ref (origin/HEAD と起点ブランチ) に対して、patch が欠けている commit が無い (git cherry)
 *   3. 未 push の commit が触ったファイルの手元の中身 (blob) が、比べる ref の履歴のどこかに現れる
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

export async function unpushedLanded(path: string, baseBranch?: string): Promise<Landed> {
  // origin/HEAD は別名なので名前に使わない
  const at = lines(await git(["for-each-ref", "--points-at", "HEAD", "--format=%(refname)", "refs/remotes"], path))
    .filter((r) => !r.endsWith("/HEAD"))
    .map((r) => r.replace(/^refs\/remotes\//, ""));
  if (at.length > 0) return { landed: true, how: `${at[0]} is at HEAD` };

  const refs = await candidates(path, baseBranch);
  if (refs.length === 0) return { landed: false, how: "no remote branch to compare with", missing: [] };

  for (const ref of refs) {
    const unique = lines(await git(["cherry", ref, "HEAD"], path)).filter((l) => l.startsWith("+"));
    if (unique.length === 0) return { landed: true, how: `every commit's patch is in ${ref}` };
  }

  const files = [...new Set(lines(await git(["log", "--format=", "--name-only", "HEAD", "--not", "--remotes"], path)))];
  let best: { ref: string; missing: string[] } | null = null;
  for (const ref of refs) {
    const missing: string[] = [];
    for (const f of files) {
      const blob = await git(["rev-parse", "--verify", "--quiet", `HEAD:${f}`], path).catch(() => "");
      if (!blob) {
        // 手元で消したファイル: ref の先にも無ければ入っている
        const there = await git(["cat-file", "-e", `${ref}:${f}`], path).then(
          () => true,
          () => false,
        );
        if (there) missing.push(f);
        continue;
      }
      const seen = await git(["log", ref, "-1", "--format=%H", `--find-object=${blob}`], path);
      if (!seen) missing.push(f);
    }
    if (missing.length === 0) return { landed: true, how: `every changed file's content is in ${ref}'s history` };
    if (!best || missing.length < best.missing.length) best = { ref, missing };
  }
  return { landed: false, how: `not in ${best!.ref}`, missing: best!.missing };
}
