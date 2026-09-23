/**
 * The tag the next release gets: one release candidate past the highest `v*` tag.
 *
 *   vX.Y.Z-rc.N  ->  vX.Y.Z-rc.(N+1)
 *   vX.Y.Z       ->  vX.Y.(Z+1)-rc.1
 *
 * Parsed here rather than left to `git tag --sort=v:refname`, which puts `v0.1.0` below its
 * own release candidates: the final version would read as the oldest, and the next tag
 * would reuse a number that already exists.
 *
 * Tags in neither shape are ignored rather than guessed at. No tag at all is an error — the
 * first version is a person's decision, not a default.
 */
type Version = readonly [major: number, minor: number, patch: number, rc: number];

const SHAPE = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

/** A final version is above every release candidate of itself, so its rc is Infinity. */
function parse(tag: string): Version | null {
  const m = SHAPE.exec(tag.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}

// Infinity - Infinity is NaN, which is falsy, so two equal finals still compare as 0.
const compare = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || 0;

export function nextTag(tags: readonly string[]): string {
  const versions = tags.map(parse).filter((v) => v !== null);
  if (!versions.length) throw new Error('no vX.Y.Z or vX.Y.Z-rc.N tag to count from');
  const [major, minor, patch, rc] = versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  return rc === Infinity
    ? `v${major}.${minor}.${patch + 1}-rc.1`
    : `v${major}.${minor}.${patch}-rc.${rc + 1}`;
}

if (import.meta.main) {
  const git = Bun.spawnSync(['git', 'tag', '--list', 'v*']);
  if (git.exitCode !== 0) {
    console.error(git.stderr.toString());
    process.exit(1);
  }
  console.log(nextTag(git.stdout.toString().split('\n')));
}
