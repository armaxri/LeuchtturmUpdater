import { assert, describe, expect, it } from 'vitest';

import { parseConfig, parseSettings } from '../../src/config';
import { settings } from './helpers';

describe('parseSettings', () => {
  it('uses defaults for missing or mistyped values', () => {
    expect(parseSettings(settings({ notify: 'yes', statusBar: 'sometimes' }))).toEqual({
      enabled: true,
      checkIntervalMinutes: 60,
      checkOnStartup: true,
      notify: true,
      includePrerelease: false,
      statusBar: 'whenUpdates',
      trackAllFromSources: false,
      httpTimeoutSeconds: 30,
      scriptTimeoutSeconds: 120,
      scriptEnabled: false,
    });
  });

  it('clamps the check interval', () => {
    expect(parseSettings(settings({ checkInterval: 0 })).checkIntervalMinutes).toBe(0);
    expect(parseSettings(settings({ checkInterval: 1 })).checkIntervalMinutes).toBe(5);
    expect(parseSettings(settings({ checkInterval: 120 })).checkIntervalMinutes).toBe(120);
  });

  it('only enables scripts for a literal true', () => {
    expect(parseSettings(settings({ 'script.enabled': 'true' })).scriptEnabled).toBe(false);
    expect(parseSettings(settings({ 'script.enabled': true })).scriptEnabled).toBe(true);
  });
});

describe('parseConfig sources', () => {
  it('parses a file source with defaults and path expansion', () => {
    const config = parseConfig(
      settings({ sources: { share: { type: 'file', path: '~/vsix/${env:TEAM}' } } }),
      { userHome: '/home/me', env: { TEAM: 'tools' } },
    );
    expect(config.problems).toEqual([]);
    expect(config.sources).toHaveLength(1);
    const share = config.sources[0]!;
    expect(share).toMatchObject({
      name: 'share',
      type: 'file',
      path: '/home/me/vsix/tools',
      recursive: false,
      include: [],
      exclude: [],
    });
    assert(share.type === 'file');
    expect(share.filePattern.exec('corp.my-linter-1.4.1.vsix')?.groups).toMatchObject({
      id: 'corp.my-linter',
      version: '1.4.1',
    });
  });

  it('reports invalid sources without dropping the valid ones', () => {
    const config = parseConfig(
      settings({
        sources: {
          good: { type: 'file', path: '/x' },
          noPath: { type: 'file' },
          badType: { type: 'ftp' },
          badRegex: { type: 'file', path: '/x', filePattern: '(' },
          noGroups: { type: 'file', path: '/x', filePattern: '^(.*)\\.vsix$' },
          badEnv: { type: 'file', path: '${env:LEUCHTTURM_DOES_NOT_EXIST}' },
          noCommand: { type: 'script' },
          off: { type: 'file', enabled: false },
          notObject: 'nope',
        },
      }),
    );
    expect(config.sources.map((s) => s.name)).toEqual(['good']);
    expect(config.problems.map((p) => p.source)).toEqual([
      'noPath',
      'badType',
      'badRegex',
      'noGroups',
      'badEnv',
      'noCommand',
      'notObject',
    ]);
    expect(config.problems.find((p) => p.source === 'noGroups')?.message).toMatch(/\(\?<id>/);
    expect(config.problems.find((p) => p.source === 'noCommand')?.message).toMatch(
      /"command" is required/,
    );
  });

  it('rejects credentials and certificates: Leuchtturm handles no logins', () => {
    const config = parseConfig(
      settings({
        sources: {
          a: {
            type: 'http',
            index: { url: 'https://x/' },
            auth: { bearer: 't' },
            match: { regex: '(?<id>a)(?<version>1)' },
            download: { url: 'https://x/' },
          },
          b: {
            type: 'http',
            index: { url: 'https://x/', headers: { 'PRIVATE-TOKEN': 't' } },
            match: { regex: '(?<id>a)(?<version>1)' },
            download: { url: 'https://x/' },
          },
          c: { type: 'npm', scope: '@corp', npmrc: '~/.npmrc' },
          d: { type: 'file', path: '/x/${secret:token}' },
        },
      }),
    );
    const messages = Object.fromEntries(config.problems.map((p) => [p.source, p.message]));
    expect(messages.a).toMatch(
      /"auth" is not supported: Leuchtturm does not handle logins.*script/,
    );
    expect(messages.b).toMatch(/"index\.headers" is not supported/);
    expect(messages.c).toMatch(/"npmrc" is not supported: Leuchtturm runs your npm/);
    expect(messages.d).toMatch(/\$\{secret:token\} is not supported.*script/);
  });
});

describe('parseConfig tracking', () => {
  it('parses all entry forms', () => {
    const config = parseConfig(
      settings({
        extensions: [
          'corp.linter',
          'share:corp.snippets',
          { id: 'corp.theme', source: 'nexus', pin: '2.1.x' },
          { id: 'corp.legacy', enabled: false },
          'CORP.LINTER',
        ],
      }),
    );
    expect(config.problems).toEqual([]);
    expect(config.tracking.map(({ pinRange: _r, ...rest }) => rest)).toEqual([
      { id: 'corp.linter' },
      { id: 'corp.snippets', source: 'share' },
      { id: 'corp.theme', source: 'nexus', pin: '2.1.x' },
    ]);
    expect(config.tracking[2]!.pinRange).toBeDefined();
  });

  it('reports invalid entries', () => {
    const config = parseConfig(
      settings({ extensions: [42, { id: 'corp.x', pin: 'nonsense' }, 'corp.ok'] }),
    );
    expect(config.tracking.map((t) => t.id)).toEqual(['corp.ok']);
    expect(config.problems).toHaveLength(2);
  });
});
