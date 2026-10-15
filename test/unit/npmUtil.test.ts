import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeTgz } from '../../src/test/tarball';
import { verifyIntegrity } from '../../src/util/hash';
import { findNpmrcAuth, nerfDart, parseNpmrc } from '../../src/util/npmrc';
import { readTar, readTgz } from '../../src/util/tar';

describe('tar reader', () => {
  it('reads files written like npm pack', async () => {
    const entries = await readTgz(
      makeTgz({
        'package/package.json': '{"name":"x"}',
        'package/x-1.0.0.vsix': Buffer.from([1, 2, 3]),
      }),
    );
    expect(entries.map((e) => [e.name, e.type, e.data.length])).toEqual([
      ['package/package.json', 'file', 12],
      ['package/x-1.0.0.vsix', 'file', 3],
    ]);
  });

  it('applies pax long names', () => {
    const pax = (name: string) => {
      const record = ` path=${name}\n`;
      const len = record.length + String(record.length + 3).length;
      return `${len}${record}`;
    };
    const header = (name: string, size: number, type: string) => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
      h.write(type, 156);
      h.write('ustar\0', 257);
      return h;
    };
    const longName = `package/${'a'.repeat(120)}.vsix`;
    const record = Buffer.from(pax(longName));
    const tar = Buffer.concat([
      header('PaxHeader', record.length, 'x'),
      record,
      Buffer.alloc(512 - record.length),
      header('short', 1, '0'),
      Buffer.from('z'),
      Buffer.alloc(511),
      Buffer.alloc(1024),
    ]);
    expect(readTar(tar).map((e) => e.name)).toEqual([longName]);
  });

  it('rejects truncated archives', () => {
    const tgzHeader = Buffer.alloc(512);
    tgzHeader.write('x', 0);
    tgzHeader.write('00000001000\0', 124);
    expect(() => readTar(tgzHeader)).toThrow(/Truncated/);
  });
});

describe('npmrc', () => {
  const rc = parseNpmrc(
    [
      '# comment',
      'registry=https://registry.npmjs.org/',
      '//nexus.corp.example/repository/npm/:_authToken=${NPM_TOKEN}',
      '//nexus.corp.example/:_auth="dXNlcjpwYXNz"',
      '//other.example/:username=bob',
      `//other.example/:_password=${Buffer.from('secret').toString('base64')}`,
    ].join('\n'),
    { NPM_TOKEN: 'tok123' },
  );

  it('computes nerf darts', () => {
    expect(nerfDart('https://nexus.corp.example:8443/repository/npm?x=1')).toBe(
      '//nexus.corp.example:8443/repository/npm/',
    );
  });

  it('picks the most specific matching entry', () => {
    expect(findNpmrcAuth(rc, 'https://nexus.corp.example/repository/npm/')?.authorization).toBe(
      'Bearer tok123',
    );
    expect(findNpmrcAuth(rc, 'https://nexus.corp.example/repository/other/')?.authorization).toBe(
      'Basic dXNlcjpwYXNz',
    );
    expect(findNpmrcAuth(rc, 'https://other.example/npm/')?.authorization).toBe(
      `Basic ${Buffer.from('bob:secret').toString('base64')}`,
    );
    expect(findNpmrcAuth(rc, 'https://unknown.example/')).toBeUndefined();
  });
});

describe('verifyIntegrity', () => {
  const data = Buffer.from('tarball');
  const sri = (alg: string) => `${alg}-${createHash(alg).update(data).digest('base64')}`;

  it('accepts matching SRI and shasum values, preferring the strongest', () => {
    expect(verifyIntegrity(data, sri('sha512'), undefined)).toBe('sha512');
    expect(verifyIntegrity(data, `${sri('sha1')} ${sri('sha512')}`, undefined)).toBe('sha512');
    expect(verifyIntegrity(data, undefined, createHash('sha1').update(data).digest('hex'))).toBe(
      'sha1',
    );
    expect(verifyIntegrity(data, undefined, undefined)).toBeUndefined();
  });

  it('throws on a mismatch', () => {
    expect(() => verifyIntegrity(Buffer.from('other'), sri('sha512'), undefined)).toThrow(
      /Integrity check failed \(sha512\)/,
    );
    expect(() => verifyIntegrity(data, undefined, '0'.repeat(40))).toThrow(/sha1/);
  });
});
