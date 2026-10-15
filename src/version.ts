/**
 * Minimal semver 2.0 parsing, comparison and range matching. No dependency needed: we only
 * need precedence rules plus the handful of range forms people write in `pin`.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, e.g. `['beta', '2']`. Empty for a release. */
  prerelease: string[];
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(text: string): SemVer | undefined {
  const m = SEMVER_RE.exec(text.trim());
  if (!m) {
    return undefined;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

export function isPrerelease(text: string): boolean {
  return (parseVersion(text)?.prerelease.length ?? 0) > 0;
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    return Math.sign(Number(a) - Number(b));
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum) {
    return -1;
  }
  if (bNum) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  const core =
    Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
  if (core !== 0) {
    return core;
  }
  // A release ranks above any of its prereleases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const c = compareIdentifiers(x, y);
    if (c !== 0) {
      return c;
    }
  }
  return 0;
}

/**
 * Compares two version strings. Invalid versions sort below every valid one (and equal to
 * each other), so a bad entry never wins a "highest version" contest.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return pa ? 1 : pb ? -1 : 0;
  }
  return compareSemVer(pa, pb);
}

// ---------------------------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------------------------

type Op = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  op: Op;
  version: SemVer;
}

/** A range is an OR of AND-sets of comparators (`a b || c`). */
export type Range = Comparator[][];

interface Partial {
  parts: number[]; // 0..3 numbers; missing or `x`/`*` parts are dropped
  prerelease: string[];
}

const PARTIAL_RE =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePartial(text: string): Partial | undefined {
  if (text === '' || text === '*' || text.toLowerCase() === 'x') {
    return { parts: [], prerelease: [] };
  }
  const m = PARTIAL_RE.exec(text);
  if (!m) {
    return undefined;
  }
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /^[xX*]$/.test(p)) {
      break;
    }
    parts.push(Number(p));
  }
  return { parts, prerelease: parts.length === 3 && m[4] ? m[4].split('.') : [] };
}

function sv(major: number, minor = 0, patch = 0, prerelease: string[] = []): SemVer {
  return { major, minor, patch, prerelease };
}

function floor(p: Partial): SemVer {
  return sv(p.parts[0] ?? 0, p.parts[1] ?? 0, p.parts[2] ?? 0, p.prerelease);
}

/** The first version *after* the partial, as an exclusive `-0` bound, e.g. `1.2` → `1.3.0-0`. */
function ceilingOf(parts: number[]): SemVer {
  const [major = 0, minor = 0, patch = 0] = parts;
  switch (parts.length) {
    case 1:
      return sv(major + 1, 0, 0, ['0']);
    case 2:
      return sv(major, minor + 1, 0, ['0']);
    default:
      return sv(major, minor, patch + 1, ['0']);
  }
}

function expandComparator(token: string): Comparator[] | undefined {
  const m = /^(\^|~>?|<=|>=|<|>|=)?\s*(.*)$/.exec(token);
  if (!m) {
    return undefined;
  }
  const op = m[1] ?? '';
  const p = parsePartial(m[2] ?? '');
  if (!p) {
    return undefined;
  }
  const n = p.parts.length;
  if (n === 0) {
    // `*`, `x`, `>=*`, ... all mean "any version". `<*` matches nothing, which nobody writes.
    return [];
  }
  switch (op) {
    case '^': {
      const [major = 0, minor = 0] = p.parts;
      let upper: SemVer;
      if (major > 0 || n === 1) {
        upper = ceilingOf([major]);
      } else if (minor > 0 || n === 2) {
        upper = ceilingOf([major, minor]);
      } else {
        upper = ceilingOf(p.parts);
      }
      return [
        { op: '>=', version: floor(p) },
        { op: '<', version: upper },
      ];
    }
    case '~':
    case '~>':
      return [
        { op: '>=', version: floor(p) },
        { op: '<', version: ceilingOf(n === 1 ? p.parts : p.parts.slice(0, 2)) },
      ];
    case '>=':
      return [{ op: '>=', version: floor(p) }];
    case '<':
      return [{ op: '<', version: n === 3 ? floor(p) : { ...floor(p), prerelease: ['0'] } }];
    case '>':
      return n === 3
        ? [{ op: '>', version: floor(p) }]
        : [{ op: '>=', version: ceilingOf(p.parts) }];
    case '<=':
      return n === 3
        ? [{ op: '<=', version: floor(p) }]
        : [{ op: '<', version: ceilingOf(p.parts) }];
    default:
      // Plain or `=`: exact for a full version, an X-range for a partial one.
      return n === 3
        ? [{ op: '=', version: floor(p) }]
        : [
            { op: '>=', version: floor(p) },
            { op: '<', version: ceilingOf(p.parts) },
          ];
  }
}

/**
 * Parses an npm-style range: exact (`1.2.3`), X-ranges (`2.1.x`, `2.1`, `*`), caret (`^1.2`),
 * tilde (`~1.2.3`), comparators (`>=1.0.0 <2`), hyphen ranges (`1.0 - 1.4`) and `||`.
 * Returns undefined if the text is not a valid range.
 */
export function parseRange(text: string): Range | undefined {
  const sets: Range = [];
  for (const rawSet of text.split('||')) {
    let set = rawSet.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) {
      set = `>=${hyphen[1]} <=${hyphen[2]}`;
    }
    // Allow `>= 1.2` by gluing an operator to the following token.
    const tokens = set
      .replace(/(\^|~>?|<=|>=|<|>|=)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    const comparators: Comparator[] = [];
    for (const token of tokens.length ? tokens : ['*']) {
      const expanded = expandComparator(token);
      if (!expanded) {
        return undefined;
      }
      comparators.push(...expanded);
    }
    sets.push(comparators);
  }
  return sets;
}

function test(c: Comparator, v: SemVer): boolean {
  const cmp = compareSemVer(v, c.version);
  switch (c.op) {
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '=':
      return cmp === 0;
  }
}

/** True if `version` satisfies `range` (a string or a range from `parseRange`). */
export function satisfies(version: string, range: string | Range): boolean {
  const v = parseVersion(version);
  const r = typeof range === 'string' ? parseRange(range) : range;
  if (!v || !r) {
    return false;
  }
  return r.some((set) => set.every((c) => test(c, v)));
}
