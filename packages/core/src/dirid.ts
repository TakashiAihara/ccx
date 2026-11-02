/**
 * dir-id: 14 Crockford base32 characters encoding a 70-bit value laid out as
 *
 *   [2 zero bits][48-bit unix ms timestamp][20 random bits]
 *
 * The timestamp sits on top, so the lexical order of dir-ids follows creation time and `created` can be recovered
 * from the directory name alone.
 *
 * The low 20 bits are drawn from crypto randomness for each new millisecond, and only incremented for further ids
 * minted by the same process within that millisecond (the ULID "monotonic" scheme). This is what keeps independent
 * processes apart (#75): every `ccx rd new` is its own process, and a UUIDv7 prefix left only the generator's
 * in-process counter (plus 2 random bits) below the timestamp, so processes started in the same millisecond could
 * mint the same dir-id. 20 bits make that rare enough for `createRepodir`'s mkdir reservation to absorb it with a
 * retry; uniqueness is still only guaranteed per machine, so a global key needs machine + path.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const DIR_ID_LENGTH = 14;

const RANDOM_BITS = 20;
const RANDOM_MAX = (1 << RANDOM_BITS) - 1;

const randomLowBits = () => crypto.getRandomValues(new Uint32Array(1))[0]! & RANDOM_MAX;

/**
 * Builds a dir-id generator. One generator per process is the intended use; `now` and `random` are injectable so
 * tests can pin a millisecond.
 */
export function createDirIdMinter(now: () => number = Date.now, random: () => number = randomLowBits): () => string {
  let lastMs = -1;
  let lastRandom = 0;

  return () => {
    const ms = now();
    if (ms > lastMs) {
      lastMs = ms;
      lastRandom = random();
    } else if (lastRandom < RANDOM_MAX) {
      // same millisecond (or the clock stepped back): stay above the previous id so the order still follows minting
      lastRandom++;
    } else {
      // the random part ran out within one millisecond: borrow the next one rather than repeat or go backwards
      lastMs++;
      lastRandom = random();
    }
    return encode(lastMs, lastRandom);
  };
}

/** Mints one dir-id. */
export const newDirId: () => string = createDirIdMinter();

export function isDirId(s: string): boolean {
  return s.length === DIR_ID_LENGTH && [...s].every((c) => CROCKFORD.includes(c));
}

/**
 * Recovers the creation time: the 70-bit value minus its low 20 random bits is the unix ms timestamp.
 *
 * dir-ids minted before #75 took the first 14 characters of a base32-encoded UUIDv7; their timestamp sits in the
 * same place, so this reads both forms.
 */
export function dirIdToDate(dirId: string): Date {
  if (!isDirId(dirId)) throw new Error(`not a dir-id: ${dirId}`);

  let bits = 0n;
  for (const c of dirId) {
    bits = (bits << 5n) | BigInt(CROCKFORD.indexOf(c));
  }
  return new Date(Number(bits >> BigInt(RANDOM_BITS)));
}

function encode(ms: number, random: number): string {
  const bits = (BigInt(ms) << BigInt(RANDOM_BITS)) | BigInt(random);

  let out = "";
  for (let i = DIR_ID_LENGTH - 1; i >= 0; i--) {
    out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
}
