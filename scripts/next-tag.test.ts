import { describe, expect, test } from 'bun:test';
import { nextTag } from './next-tag.ts';

/**
 * Every push to main that passes CI releases under the tag this returns, and install.sh
 * hands out whatever is latest. A wrong answer either fails the release on a tag that
 * exists or publishes a version that sorts below the one before it.
 */
describe('nextTag', () => {
  test('steps the release candidate', () => {
    expect(nextTag(['v0.1.0-rc.1', 'v0.1.0-rc.2', 'v0.1.0-rc.3'])).toBe('v0.1.0-rc.4');
  });

  test('compares rc numbers as numbers, not text', () => {
    expect(nextTag(['v0.1.0-rc.9', 'v0.1.0-rc.10', 'v0.1.0-rc.2'])).toBe('v0.1.0-rc.11');
  });

  test('compares patch numbers as numbers, not text', () => {
    expect(nextTag(['v0.1.9', 'v0.1.10'])).toBe('v0.1.11-rc.1');
  });

  test('counts rc.0 as a release candidate, not a final version', () => {
    expect(nextTag(['v0.1.0-rc.0'])).toBe('v0.1.0-rc.1');
  });

  test('puts a final version above its own release candidates, and starts the next patch', () => {
    expect(nextTag(['v0.1.0-rc.3', 'v0.1.0', 'v0.1.0-rc.2'])).toBe('v0.1.1-rc.1');
  });

  test('takes the highest version, whatever order the tags come in', () => {
    expect(nextTag(['v0.2.0-rc.1', 'v0.10.0-rc.1', 'v0.9.9'])).toBe('v0.10.0-rc.2');
    expect(nextTag(['v1.0.0-rc.1', 'v0.9.0'])).toBe('v1.0.0-rc.2');
  });

  test('ignores tags in any other shape', () => {
    expect(nextTag(['v0.1.0-rc.3', 'v9', 'latest', 'v2.0.0-beta.1', ''])).toBe('v0.1.0-rc.4');
  });

  test('refuses to invent a first version', () => {
    expect(() => nextTag(['latest', ''])).toThrow();
  });
});
