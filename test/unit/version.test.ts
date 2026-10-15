import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isPrerelease,
  isValidVersion,
  parseRange,
  parseVersion,
  satisfies,
} from '../../src/version';

describe('parseVersion', () => {
  it('parses releases, prereleases, build metadata and a leading v', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v1.2.3-beta.2+build.7')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', '2'],
    });
  });

  it('rejects invalid versions', () => {
    for (const bad of ['1.2', '1.2.3.4', '01.2.3', 'abc', '', '1.2.3-', '1.2.3-a..b']) {
      expect(isValidVersion(bad), bad).toBe(false);
    }
  });
});

describe('compareVersions', () => {
  it('follows semver precedence', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.2.0',
      '1.10.0',
      '2.0.0',
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(
        compareVersions(ordered[i]!, ordered[i + 1]!),
        `${ordered[i]} < ${ordered[i + 1]}`,
      ).toBe(-1);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBe(1);
    }
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
  });

  it('ignores build metadata and sorts invalid versions last', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareVersions('garbage', '0.0.1')).toBe(-1);
    expect(compareVersions('0.0.1', 'garbage')).toBe(1);
  });

  it('detects prereleases', () => {
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

describe('satisfies', () => {
  const cases: [string, string, boolean][] = [
    ['2.1.5', '2.1.x', true],
    ['2.2.0', '2.1.x', false],
    ['2.1.0', '2.1', true],
    ['2.9.9', '2', true],
    ['3.0.0', '2', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '=1.2.3', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.2', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '>=1.2.0 <2', true],
    ['2.0.0', '>=1.2.0 <2', false],
    ['1.5.0', '>= 1.2.0', true],
    ['1.4.0', '1.0 - 1.4', true],
    ['1.5.0', '1.0 - 1.4', false],
    ['3.0.0', '^1.0.0 || ^3.0.0', true],
    ['2.0.0', '^1.0.0 || ^3.0.0', false],
    ['9.9.9', '*', true],
    ['1.3.0', '>1.2', true],
    ['1.2.9', '>1.2', false],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['2.0.0-beta.1', '^1.0.0', false],
    ['1.0.0', 'not a range', false],
  ];
  for (const [version, range, expected] of cases) {
    it(`${version} ${expected ? 'satisfies' : 'does not satisfy'} "${range}"`, () => {
      expect(satisfies(version, range)).toBe(expected);
    });
  }

  it('rejects invalid ranges', () => {
    expect(parseRange('1.x.y.z')).toBeUndefined();
    expect(parseRange('banana')).toBeUndefined();
  });
});
