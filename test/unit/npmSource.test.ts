/**
 * The npm source runs the real npm CLI against a local fake registry. The npm configuration
 * (scope registry, token) lives in a test `.npmrc`, standing in for the user's own: Leuchtturm
 * itself never sees the token.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { parseConfig, type NpmSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import { NpmSource } from '../../src/sources/npmSource';
import { startFakeServer, type FakeServer, type FakeServerConfig } from '../../src/test/fakeServer';
import { makeTgz } from '../../src/test/tarball';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import { NpmNotFoundError, npmErrorSummary, resolveNpm } from '../../src/util/npmCli';
import { settings, tempDir } from './helpers';

const TOKEN = 'npm-test-token';
const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

// npm reads its user configuration from here. Both spellings: `npm run` (which runs vitest)
// sets the lowercase one, and npm prefers it.
const savedEnv = {
  upper: process.env.NPM_CONFIG_USERCONFIG,
  lower: process.env.npm_config_userconfig,
};
afterAll(() => {
  process.env.NPM_CONFIG_USERCONFIG = savedEnv.upper;
  process.env.npm_config_userconfig = savedEnv.lower;
});
async function npmConfig(lines: string[]): Promise<void> {
  // A fresh folder per test: temp folders are cleaned up after each test.
  const npmrc = path.join(await tempDir(), 'npmrc');
  // No retries: a broken download should fail the test at once.
  await fs.writeFile(npmrc, `${[...lines, 'fetch-retries=0'].join('\n')}\n`);
  process.env.NPM_CONFIG_USERCONFIG = npmrc;
  process.env.npm_config_userconfig = npmrc;
}

function pkg(vsixName: string, extra: Record<string, string | Buffer> = {}) {
  return makeTgz({
    'package/package.json': '{}',
    [`package/${vsixName}`]: Buffer.from(`vsix ${vsixName}`),
    ...extra,
  });
}

const packages: NonNullable<FakeServerConfig['npm']>['packages'] = {
  '@corp/linter': {
    '1.3.0': { tgz: pkg('corp.linter-1.3.0.vsix'), manifest: { vscodeExtension: 'corp.linter' } },
    '1.4.0': {
      tgz: pkg('corp.linter-1.4.0.vsix'),
      manifest: { vscodeExtension: 'corp.linter', displayName: 'Corp Linter' },
    },
    '1.5.0-beta.1': {
      tgz: pkg('corp.linter-1.5.0-beta.1.vsix'),
      manifest: { vscodeExtension: 'corp.linter' },
    },
  },
  // An extension's own package.json: publisher + package name.
  '@corp/theme': {
    '2.0.0': { tgz: pkg('corp.theme-2.0.0.vsix'), manifest: { publisher: 'corp' } },
  },
  // No hints at all: the ID comes from the .vsix inside the newest version.
  '@corp/derived': {
    '0.1.0': { tgz: pkg('corp.derived-0.1.0.vsix') },
    '0.2.0': { tgz: pkg('corp.derived-0.2.0.vsix') },
  },
  '@corp/tampered': {
    '1.0.0': {
      tgz: pkg('corp.tampered-1.0.0.vsix'),
      manifest: { vscodeExtension: 'corp.tampered', dist: { integrity: 'sha512-AAAA' } },
    },
  },
  '@corp/two': {
    '1.0.0': {
      tgz: pkg('corp.two-1.0.0.vsix', { 'package/extra-1.0.0.vsix': 'x' }),
      manifest: { vscodeExtension: 'corp.two' },
    },
  },
};

/** A registry that needs a token, configured for npm the way a user would. */
async function registry(): Promise<string> {
  const s = await startFakeServer({ npm: { token: TOKEN, packages } });
  servers.push(s);
  const url = `${s.url}/npm/`;
  await npmConfig([`@corp:registry=${url}`, `${url.replace(/^https?:/, '')}:_authToken=${TOKEN}`]);
  return url;
}

function source(raw: Record<string, unknown>) {
  const config = parseConfig(settings({ sources: { corp: { type: 'npm', ...raw } } }));
  expect(config.problems).toEqual([]);
  return new NpmSource(config.sources[0] as NpmSourceConfig, 30_000, NULL_LOGGER);
}

describe('NpmSource (real npm CLI)', () => {
  it('lists a scope with the registry and token from npm’s own configuration', async () => {
    await registry();
    const lines: string[] = [];
    const artifacts = await source({ scope: '@corp' }).list(NEVER_CANCELLED, (l) => lines.push(l));
    const byId = Object.fromEntries(artifacts.map((a) => [a.id, a]));
    // Three ways to the extension ID; prereleases are listed (the checker filters them).
    expect(byId['corp.linter']?.versions.map((v) => v.version)).toEqual([
      '1.5.0-beta.1',
      '1.4.0',
      '1.3.0',
    ]);
    expect(byId['corp.linter']?.displayName).toBe('Corp Linter');
    expect(byId['corp.theme']?.versions.map((v) => v.version)).toEqual(['2.0.0']);
    expect(byId['corp.derived']?.versions.map((v) => v.version)).toEqual(['0.2.0', '0.1.0']);
    const report = lines.join('\n');
    expect(report).toContain('npm config get @corp:registry');
    expect(report).toContain('Search for @corp: 5 package(s)');
    expect(report).toContain(
      '@corp/derived: extension ID corp.derived taken from the .vsix in 0.2.0',
    );
    expect(report).not.toContain(TOKEN);
  }, 60_000);

  it('downloads with npm pack and extracts the .vsix', async () => {
    await registry();
    const src = source({ packages: ['@corp/linter'] });
    const [linter] = await src.list(NEVER_CANCELLED);
    const file = await src.download(
      linter!,
      linter!.versions.find((v) => v.version === '1.3.0')!,
      await tempDir(),
      NEVER_CANCELLED,
    );
    expect(path.basename(file)).toBe('corp.linter-1.3.0.vsix');
    expect(await fs.readFile(file, 'utf8')).toBe('vsix corp.linter-1.3.0.vsix');
  }, 60_000);

  it('leaves integrity checks to npm and reports its errors', async () => {
    await registry();
    const src = source({ packages: ['@corp/tampered', '@corp/two'] });
    const artifacts = await src.list(NEVER_CANCELLED);
    const get = (id: string) => artifacts.find((a) => a.id === id)!;
    await expect(
      src.download(
        get('corp.tampered'),
        get('corp.tampered').versions[0]!,
        await tempDir(),
        NEVER_CANCELLED,
      ),
    ).rejects.toThrow(/npm pack failed: .*integrity/i);
    await expect(
      src.download(get('corp.two'), get('corp.two').versions[0]!, await tempDir(), NEVER_CANCELLED),
    ).rejects.toThrow(/several \.vsix files/);
  }, 60_000);

  it('says when npm itself has no login for the registry', async () => {
    const url = await registry();
    await npmConfig([`@corp:registry=${url}`]); // no token
    await expect(source({ packages: ['@corp/linter'] }).list(NEVER_CANCELLED)).rejects.toThrow(
      /npm view failed: .*(E401|auth)/i,
    );
  }, 60_000);

  it('uses an explicit registry from the source settings', async () => {
    const url = await registry();
    await npmConfig([`${url.replace(/^https?:/, '')}:_authToken=${TOKEN}`]); // no scope mapping
    const artifacts = await source({ registry: url, packages: ['@corp/theme'] }).list(
      NEVER_CANCELLED,
    );
    expect(artifacts.map((a) => a.id)).toEqual(['corp.theme']);
  }, 60_000);
});

describe('npm CLI lookup', () => {
  it('runs npm-cli.js with the node.exe next to npm.cmd on Windows (no shell)', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, 'node_modules/npm/bin'), { recursive: true });
    for (const f of ['npm.cmd', 'node.exe', 'node_modules/npm/bin/npm-cli.js']) {
      await fs.writeFile(path.join(dir, f), '');
    }
    expect(resolveNpm({ PATH: dir }, 'win32')).toEqual({
      command: path.join(dir, 'node.exe'),
      prefix: [path.join(dir, 'node_modules/npm/bin/npm-cli.js')],
    });
    expect(() => resolveNpm({ PATH: path.join(dir, 'nothing') }, 'win32')).toThrow(
      NpmNotFoundError,
    );
    expect(() => resolveNpm({ PATH: '' }, 'linux')).toThrow(/npm was not found/);
  });

  it('summarises npm errors without the log-file noise', () => {
    expect(
      npmErrorSummary({
        code: 1,
        stdout: '{\n  "error": {\n    "summary": "x"\n  }\n}',
        stderr:
          'npm error code E401\nnpm error Unable to authenticate\nnpm error A complete log of this run can be found in: /x.log\n',
      }),
    ).toBe('code E401 Unable to authenticate');
  });
});

describe('npm source config', () => {
  it('normalizes registry and scope; the registry is optional', () => {
    const config = parseConfig(
      settings({
        sources: {
          a: { type: 'npm', registry: 'https://r.example/npm', scope: 'corp' },
          b: { type: 'npm', packages: ['@corp/x'] },
        },
      }),
    );
    expect(config.problems).toEqual([]);
    expect(config.sources[0]).toMatchObject({ registry: 'https://r.example/npm/', scope: '@corp' });
    expect(config.sources[1]).toMatchObject({ registry: undefined, packages: ['@corp/x'] });
  });

  it('reports invalid settings, and credentials that belong to npm', () => {
    const problems = parseConfig(
      settings({
        sources: {
          none: { type: 'npm' },
          scope: { type: 'npm', scope: '@Bad Scope' },
          registry: { type: 'npm', registry: 'ftp://x', scope: '@a' },
          auth: { type: 'npm', scope: '@a', auth: { token: 't' } },
        },
      }),
    ).problems.map((p) => p.message);
    expect(problems).toEqual([
      expect.stringMatching(/set "scope" .* or list "packages"/),
      expect.stringMatching(/not a valid npm scope/),
      expect.stringMatching(/must be an http/),
      expect.stringMatching(/"auth" is not supported: Leuchtturm runs your npm/),
    ]);
  });
});
