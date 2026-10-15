import { describe, expect, it } from 'vitest';

import { parseJsonPath, queryJsonPath } from '../../src/util/jsonPath';

const doc = {
  builds: [
    { number: 2, artifacts: [{ fileName: 'a-2.vsix' }, { fileName: 'b-2.vsix' }] },
    { number: 1, artifacts: [{ fileName: 'a-1.vsix' }] },
  ],
  'odd key': { x: 1 },
};

const values = (path: string) => queryJsonPath(doc, path).map((r) => r.value);

describe('queryJsonPath', () => {
  it('supports keys, indices, wildcards and quoted keys', () => {
    expect(values('$.builds[0].number')).toEqual([2]);
    expect(values('$.builds[-1].number')).toEqual([1]);
    expect(values('$.builds[*].number')).toEqual([2, 1]);
    expect(values('$.builds.*.number')).toEqual([2, 1]);
    expect(values("$['odd key'].x")).toEqual([1]);
    expect(values('$["odd key"].x')).toEqual([1]);
    expect(values('$')).toEqual([doc]);
  });

  it('supports recursive descent', () => {
    expect(values('$..fileName')).toEqual(['a-2.vsix', 'b-2.vsix', 'a-1.vsix']);
  });

  it('keeps ancestors of every result', () => {
    const [first] = queryJsonPath(doc, '$.builds[*].artifacts[*]');
    expect(first!.ancestors.map((a) => (a as { number?: number }).number)).toEqual([
      undefined,
      undefined,
      2,
      undefined,
    ]);
  });

  it('returns nothing for missing paths and rejects unsupported syntax', () => {
    expect(values('$.nope.deeper')).toEqual([]);
    expect(values('$.builds[9]')).toEqual([]);
    expect(() => parseJsonPath('builds')).toThrow(/must start with/);
    expect(() => parseJsonPath('$.builds[?(@.x)]')).toThrow(/Unsupported/);
  });
});
