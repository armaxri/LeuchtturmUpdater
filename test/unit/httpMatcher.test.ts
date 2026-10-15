import { describe, expect, it } from 'vitest';

import { parseConfig, type HttpSourceConfig } from '../../src/config';
import { extractMatches } from '../../src/sources/httpMatcher';
import { settings } from './helpers';

function match(m: Record<string, unknown>): HttpSourceConfig['match'] {
  const config = parseConfig(
    settings({
      sources: {
        s: { type: 'http', index: { url: 'http://x' }, match: m, download: { url: 'http://x' } },
      },
    }),
  );
  expect(config.problems).toEqual([]);
  const s = config.sources[0]!;
  if (s.type !== 'http') {
    throw new Error('expected http');
  }
  return s.match;
}

const jenkins = JSON.stringify({
  builds: [
    {
      number: 42,
      result: 'SUCCESS',
      artifacts: [
        { fileName: 'corp.linter-1.4.1.vsix', relativePath: 'out/corp.linter-1.4.1.vsix' },
        { fileName: 'notes.txt', relativePath: 'notes.txt' },
      ],
    },
    {
      number: 41,
      result: 'FAILURE',
      artifacts: [{ fileName: 'corp.linter-1.4.0.vsix', relativePath: 'x' }],
    },
  ],
});

describe('extractMatches', () => {
  it('collects every regex match with its named groups', () => {
    const html = '<a href="corp.a-1.0.0.vsix">x</a> <a href="corp.b-2.0.0.vsix">y</a>';
    const m = match({ regex: 'href="(?<file>(?<id>corp\\.\\w+)-(?<version>[\\d.]+)\\.vsix)"' });
    expect(extractMatches(html, m).records).toEqual([
      { file: 'corp.a-1.0.0.vsix', id: 'corp.a', version: '1.0.0' },
      { file: 'corp.b-2.0.0.vsix', id: 'corp.b', version: '2.0.0' },
    ]);
  });

  it('supports the regex-on-JSON style from the spec example', () => {
    const m = match({
      regex:
        '"fileName":"(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix","relativePath":"(?<path>[^"]+)"',
    });
    expect(extractMatches(jenkins, m).records.map((r) => r.path)).toEqual([
      'out/corp.linter-1.4.1.vsix',
      'x',
    ]);
  });

  it('exposes fields of the selected object and its ancestors in jsonPath mode', () => {
    const m = match({
      jsonPath: '$.builds[*].artifacts[*]',
      where: { result: 'SUCCESS' },
      field: 'fileName',
      regex: '^(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix$',
    });
    const { records, skipped } = extractMatches(jenkins, m);
    expect(records).toEqual([
      {
        number: '42',
        result: 'SUCCESS',
        fileName: 'corp.linter-1.4.1.vsix',
        relativePath: 'out/corp.linter-1.4.1.vsix',
        id: 'corp.linter',
        version: '1.4.1',
      },
    ]);
    expect(skipped).toEqual([
      expect.stringContaining('"fileName" does not match the regex'),
      expect.stringContaining('filtered by "where"'),
    ]);
  });

  it('uses scalar values directly', () => {
    const m = match({ jsonPath: '$.versions[*]', id: 'corp.x', regex: '^(?<version>.+)$' });
    expect(extractMatches('{"versions":["1.0.0","1.1.0"]}', m).records).toEqual([
      { value: '1.0.0', version: '1.0.0' },
      { value: '1.1.0', version: '1.1.0' },
    ]);
  });

  it('fails clearly on a non-JSON body in jsonPath mode', () => {
    expect(() => extractMatches('<html>', match({ jsonPath: '$.x' }))).toThrow(/not valid JSON/);
  });
});
