import { describe, expect, it } from 'vitest';

import { matchesFilters } from '../../src/util/glob';

describe('matchesFilters', () => {
  it('applies include and exclude globs case-insensitively', () => {
    expect(matchesFilters('corp.linter', [], [])).toBe(true);
    expect(matchesFilters('Corp.Linter', ['corp.*'], [])).toBe(true);
    expect(matchesFilters('other.linter', ['corp.*'], [])).toBe(false);
    expect(matchesFilters('corp.legacy', ['corp.*'], ['*.legacy'])).toBe(false);
    expect(matchesFilters('corp.a', ['corp.?'], [])).toBe(true);
    expect(matchesFilters('corpXlinter', ['corp.linter'], [])).toBe(false);
  });
});
