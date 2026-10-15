import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config';
import { settings } from './helpers';

function parse(source: Record<string, unknown>, secrets: Record<string, string> = {}) {
  return parseConfig(settings({ sources: { s: { type: 'http', ...source } } }), {
    secrets,
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
    const { sources, problems } = parse(
      {
        ...minimal,
        index: { ...minimal.index, headers: { 'X-Token': '${secret:t}' } },
        auth: { basic: { user: 'u', password: '${secret:pw}' } },
        ca: '~/corp-ca.pem',
      },
      { t: 'tok', pw: 'pass' },
    );
    expect(problems).toEqual([]);
    const s = sources[0]!;
    expect(s.type === 'http' && s).toMatchObject({
      index: { url: 'https://jenkins.example/api', method: 'GET', headers: { 'X-Token': 'tok' } },
      download: { url: 'https://${env:HOST}/${id}-${version}.vsix' },
      authorization: `Basic ${Buffer.from('u:pass').toString('base64')}`,
      strictSSL: true,
      caPath: '/home/me/corp-ca.pem',
      sensitiveValues: [Buffer.from('u:pass').toString('base64'), 'pass'],
    });
    expect(s.type === 'http' && s.match.regex?.flags).toBe('g');
  });

  it('accepts strictSSL on the index object (spec example)', () => {
    const s = parse({ ...minimal, index: { ...minimal.index, strictSSL: false } }).sources[0]!;
    expect(s.type === 'http' && s.strictSSL).toBe(false);
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
      'missing secret',
      { ...minimal, auth: { bearer: '${secret:nope}' } },
      /Secret "nope" is not stored/,
    ],
    ['missing env', { ...minimal, download: { url: '${env:NOPE}/${id}' } }, /"NOPE" is not set/],
    ['bad auth', { ...minimal, auth: { digest: {} } }, /"auth" must be/],
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
