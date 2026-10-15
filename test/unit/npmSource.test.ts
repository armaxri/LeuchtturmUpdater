import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig, type NpmSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import { NpmSource } from '../../src/sources/npmSource';
import { startFakeServer, type FakeServer, type FakeServerConfig } from '../../src/test/fakeServer';
import { makeTgz } from '../../src/test/tarball';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import { settings, tempDir } from './helpers';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function pkg(vsixName: string, extra: Record<string, string | Buffer> = {}) {
  return makeTgz({
    'package/package.json': '{}',
    [`package/${vsixName}`]: Buffer.from(`vsix ${vsixName}`),
    ...extra,
  });
}

const packages: NonNullable<FakeServerConfig['npm']>['packages'] = {
  '@corp/linter': {
    '1.3.0': {
      tgz: pkg('corp.linter-1.3.0.vsix'),
      manifest: { vscodeExtension: 'corp.linter', displayName: 'Corp Linter' },
    },
    '1.4.0': { tgz: pkg('corp.linter-1.4.0.vsix'), manifest: { vscodeExtension: 'corp.linter' } },
    '1.4.1': {
      tgz: pkg('corp.linter-1.4.1.vsix'),
      manifest: { vscodeExtension: 'corp.linter', deprecated: 'broken' },
    },
  },
  // An extension's own package.json: publisher + package name.
  '@corp/theme': {
    '2.0.0': { tgz: pkg('corp.theme-2.0.0.vsix'), manifest: { publisher: 'corp' } },
  },
  // No hints at all: the ID comes from the .vsix inside the newest tarball.
  '@corp/derived': {
    '0.1.0': { tgz: pkg('corp.derived-0.1.0.vsix') },
    '0.2.0': { tgz: pkg('corp.derived-0.2.0.vsix') },
  },
  '@corp/tampered': {
    '1.0.0': {
      tgz: pkg('corp.tampered-1.0.0.vsix'),
      manifest: {
        vscodeExtension: 'corp.tampered',
        dist: { integrity: 'sha512-AAAA', shasum: undefined },
      },
    },
  },
  '@corp/two': {
    '1.0.0': {
      tgz: pkg('corp.two-1.0.0.vsix', { 'package/extra-1.0.0.vsix': 'x' }),
      manifest: { vscodeExtension: 'corp.two' },
    },
  },
};

async function registry(config: Partial<NonNullable<FakeServerConfig['npm']>> = {}) {
  const s = await startFakeServer({ npm: { packages, ...config } });
  servers.push(s);
  return s;
}

function source(raw: Record<string, unknown>, secrets: Record<string, string> = {}) {
  const added: string[] = [];
  const config = parseConfig(settings({ sources: { nexus: { type: 'npm', ...raw } } }), {
    secrets,
  });
  expect(config.problems).toEqual([]);
  const src = new NpmSource(config.sources[0] as NpmSourceConfig, 5000, NULL_LOGGER, (v) =>
    added.push(v),
  );
  return { src, added };
}

describe('NpmSource', () => {
  it('lists a scope via the search API and resolves extension IDs three ways', async () => {
    const s = await registry({ token: 'tok' });
    const { src } = source(
      { registry: `${s.url}/npm`, scope: 'corp', auth: { token: '${secret:npm}' } },
      { npm: 'tok' },
    );
    const lines: string[] = [];
    const artifacts = await src.list(NEVER_CANCELLED, (l) => lines.push(l));
    const summary = Object.fromEntries(
      artifacts.map((a) => [a.id, a.versions.map((v) => v.version)]),
    );
    expect(summary).toEqual({
      'corp.derived': ['0.2.0', '0.1.0'],
      'corp.linter': ['1.4.0', '1.3.0'],
      'corp.theme': ['2.0.0'],
      'corp.tampered': ['1.0.0'],
      'corp.two': ['1.0.0'],
    });
    expect(artifacts.find((a) => a.id === 'corp.linter')?.displayName).toBe('Corp Linter');
    const report = lines.join('\n');
    expect(report).toContain('Search for @corp: 5 package(s)');
    expect(report).toContain('@corp/linter@1.4.1: skipped, deprecated (broken)');
    expect(report).toContain(
      '@corp/derived: extension ID corp.derived taken from the .vsix in 0.2.0',
    );
  });

  it('downloads the .vsix out of the tarball after checking its integrity', async () => {
    const s = await registry();
    const { src } = source({
      registry: `${s.url}/npm/`,
      packages: ['@corp/linter', '@corp/tampered', '@corp/two'],
    });
    const artifacts = await src.list(NEVER_CANCELLED);
    const linter = artifacts.find((a) => a.id === 'corp.linter')!;
    const dir = await tempDir();
    const file = await src.download(linter, linter.versions[0]!, dir, NEVER_CANCELLED);
    expect(path.basename(file)).toBe('corp.linter-1.4.0.vsix');
    expect(await fs.readFile(file, 'utf8')).toBe('vsix corp.linter-1.4.0.vsix');

    const tampered = artifacts.find((a) => a.id === 'corp.tampered')!;
    await expect(
      src.download(tampered, tampered.versions[0]!, dir, NEVER_CANCELLED),
    ).rejects.toThrow(/Integrity check failed/);
    const two = artifacts.find((a) => a.id === 'corp.two')!;
    await expect(src.download(two, two.versions[0]!, dir, NEVER_CANCELLED)).rejects.toThrow(
      /several \.vsix files/,
    );
  });

  it('reads credentials from an .npmrc when no auth is configured', async () => {
    const s = await registry({ token: 'from-npmrc' });
    const npmrc = path.join(await tempDir(), '.npmrc');
    await fs.writeFile(npmrc, `${s.url.replace(/^http:/, '')}/npm/:_authToken=from-npmrc\n`);
    const { src, added } = source({ registry: `${s.url}/npm/`, packages: ['@corp/theme'], npmrc });
    expect((await src.list(NEVER_CANCELLED)).map((a) => a.id)).toEqual(['corp.theme']);
    expect(added).toEqual(['from-npmrc']);

    const { src: without } = source({
      registry: `${s.url}/npm/`,
      packages: ['@corp/theme'],
      npmrc: '/nope/.npmrc',
    });
    await expect(without.list(NEVER_CANCELLED)).rejects.toThrow(/HTTP 401/);
  });

  it('explains registries without a search API and keeps going when one package fails', async () => {
    const s = await registry({ search: false });
    const { src } = source({ registry: `${s.url}/npm/`, scope: '@corp' });
    await expect(src.list(NEVER_CANCELLED)).rejects.toThrow(/does not support the search API/);

    const { src: partial } = source({
      registry: `${s.url}/npm/`,
      packages: ['@corp/theme', '@corp/missing'],
    });
    expect((await partial.list(NEVER_CANCELLED)).map((a) => a.id)).toEqual(['corp.theme']);
  });
});

describe('npm source config', () => {
  const parse = (raw: Record<string, unknown>) =>
    parseConfig(settings({ sources: { n: { type: 'npm', ...raw } } }), { userHome: '/home/me' });

  it('normalizes registry and scope, defaults to ~/.npmrc', () => {
    const s = parse({ registry: 'https://nexus/repository/npm', scope: 'corp-vscode' }).sources[0];
    expect(s).toMatchObject({
      registry: 'https://nexus/repository/npm/',
      scope: '@corp-vscode',
      npmrcPath: '/home/me/.npmrc',
      strictSSL: true,
    });
  });

  it('reports invalid settings', () => {
    expect(parse({ scope: 'x' }).problems[0]?.message).toMatch(/"registry" is required/);
    expect(parse({ registry: 'ftp://x', scope: 'x' }).problems[0]?.message).toMatch(/http/);
    expect(parse({ registry: 'https://x' }).problems[0]?.message).toMatch(/set "scope"/);
    expect(parse({ registry: 'https://x', packages: ['Bad Name'] }).problems[0]?.message).toMatch(
      /invalid package name/,
    );
  });
});
