import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config';
import { settings } from './helpers';

function parse(source: Record<string, unknown>) {
  return parseConfig(settings({ sources: { s: { type: 'http', ...source } } }), {
    env: { HOST: 'jenkins.example' },
    userHome: '/home/me',
  });
}

const minimal = {
  index: { url: 'https://${env:HOST}/api' },
  match: { regex: '(?<id>a\\.b)-(?<version>\\d+\\.\\d+\\.\\d+)' },
  download: { url: 'https://${env:HOST}/${id}-${version}.vsix' },
};

describe('http source config', () => {
  it('expands the index request and keeps per-version templates', () => {
    const { sources, problems } = parse(minimal);
    expect(problems).toEqual([]);
    const s = sources[0]!;
    expect(s.type === 'http' && s).toMatchObject({
      index: { url: 'https://jenkins.example/api', method: 'GET' },
      download: { url: 'https://${env:HOST}/${id}-${version}.vsix' },
    });
    expect(s.type === 'http' && s.match.regex?.flags).toBe('g');
  });

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    ['no index', { ...minimal, index: undefined }, /"index" is required/],
    ['bad method', { ...minimal, index: { url: 'x', method: 'PUT' } }, /index.method/],
    ['no match', { ...minimal, match: {} }, /needs a "regex", a "jsonPath"/],
    [
      'no id group',
      { ...minimal, match: { regex: '(?<version>.+)' } },
      /\(\?<id>…\) or set "match.id"/,
    ],
    ['bad flags', { ...minimal, match: { ...minimal.match, flags: 'x' } }, /match.flags/],
    ['bad jsonPath', { ...minimal, match: { jsonPath: 'builds' } }, /must start with/],
    [
      'unknown group',
      { ...minimal, download: { url: '${path}' } },
      /uses \$\{path\}, which is not a named group/,
    ],
    [
      'a ${secret:…} reference',
      { ...minimal, download: { url: 'https://x/${secret:nope}/${id}' } },
      /does not handle credentials/,
    ],
    ['auth', { ...minimal, auth: { bearer: 't' } }, /"auth" is not supported/],
    ['strictSSL', { ...minimal, strictSSL: false }, /"strictSSL" is not supported/],
    [
      'ca on the index',
      { ...minimal, index: { ...minimal.index, ca: '~/ca.pem' } },
      /"index\.ca" is not supported/,
    ],
    [
      'download headers',
      { ...minimal, download: { ...minimal.download, headers: {} } },
      /"download\.headers" is not supported/,
    ],
    ['missing env', { ...minimal, download: { url: '${env:NOPE}/${id}' } }, /"NOPE" is not set/],
  ];
  for (const [name, source, message] of invalid) {
    it(`reports ${name}`, () => {
      const { sources, problems } = parse(source);
      expect(sources).toEqual([]);
      expect(problems[0]?.message).toMatch(message);
    });
  }

  it('does not check plain names in jsonPath mode, where fields are known only at runtime', () => {
    const { problems } = parse({
      ...minimal,
      match: { jsonPath: '$.builds[*]' },
      download: { url: 'https://x/${number}/${relativePath}' },
    });
    expect(problems).toEqual([]);
  });
});
