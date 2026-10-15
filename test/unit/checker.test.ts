import { describe, expect, it } from 'vitest';

import { computeState, listAll, type ComputeInput, type SourceResult } from '../../src/checker';
import { parseConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import type { Artifact, Source } from '../../src/sources/types';
import { CancellationSource, NEVER_CANCELLED } from '../../src/util/cancellation';
import { settings } from './helpers';

function artifact(id: string, ...versions: string[]): Artifact {
  return {
    id,
    kind: 'vscode-extension',
    versions: versions.map((version) => ({ version, ref: {} })),
  };
}

function result(source: string, ...artifacts: Artifact[]): SourceResult {
  return { source, type: 'file', artifacts, durationMs: 1 };
}

function compute(overrides: Partial<ComputeInput> & Pick<ComputeInput, 'results'>) {
  return computeState({
    tracking: [],
    trackAllFromSources: false,
    includePrerelease: false,
    installedVersion: () => undefined,
    isSkipped: () => false,
    now: 1000,
    ...overrides,
  });
}

function tracking(...entries: unknown[]) {
  return parseConfig(settings({ extensions: entries })).tracking;
}

describe('computeState', () => {
  const installed: Record<string, string> = {
    'corp.linter': '1.3.0',
    'corp.theme': '2.1.0',
    'corp.newer': '5.0.0',
  };
  const installedVersion = (id: string) => installed[id.toLowerCase()];

  it('tracks installed artifacts offered by any source when the list is empty', () => {
    const state = compute({
      results: [
        result(
          'share',
          artifact('corp.linter', '1.4.1', '1.3.0'),
          artifact('corp.theme', '2.1.0'),
          artifact('corp.newer', '4.0.0'),
          artifact('corp.notinstalled', '1.0.0'),
        ),
      ],
      installedVersion,
    });
    expect(state.artifacts.map((a) => [a.id, a.status, a.latest?.version])).toEqual([
      ['corp.linter', 'update', '1.4.1'],
      ['corp.newer', 'up-to-date', '4.0.0'],
      ['corp.theme', 'up-to-date', '2.1.0'],
    ]);
    expect(state.problems).toEqual([]);
    expect(state.checkedAt).toBe(1000);
  });

  it('shows everything with trackAllFromSources', () => {
    const state = compute({
      results: [result('share', artifact('corp.linter', '1.4.1'), artifact('corp.x', '1.0.0'))],
      installedVersion,
      trackAllFromSources: true,
    });
    expect(state.artifacts.map((a) => [a.id, a.status])).toEqual([
      ['corp.linter', 'update'],
      ['corp.x', 'not-installed'],
    ]);
  });

  it('takes the highest version across sources and breaks ties by source order', () => {
    const state = compute({
      results: [
        result('a', artifact('corp.linter', '1.4.0', '1.3.0')),
        result('b', artifact('CORP.LINTER', '1.4.0', '1.2.0')),
        result('c', artifact('corp.linter', '1.3.5')),
      ],
      installedVersion,
    });
    const [linter] = state.artifacts;
    expect(linter!.latest).toMatchObject({ version: '1.4.0', sourceName: 'a' });
    expect(linter!.candidates.map((c) => `${c.version}@${c.sourceName}`)).toEqual([
      '1.4.0@a',
      '1.3.5@c',
      '1.3.0@a',
      '1.2.0@b',
    ]);
  });

  it('restricts to the configured source and pin', () => {
    const state = compute({
      results: [
        result('a', artifact('corp.linter', '1.5.0'), artifact('corp.theme', '3.0.0', '2.1.4')),
        result('b', artifact('corp.linter', '1.4.0')),
      ],
      tracking: tracking('b:corp.linter', { id: 'corp.theme', pin: '2.1.x' }),
      installedVersion,
    });
    expect(state.artifacts.map((a) => [a.id, a.latest?.version, a.latest?.sourceName])).toEqual([
      ['corp.linter', '1.4.0', 'b'],
      ['corp.theme', '2.1.4', 'a'],
    ]);
    expect(state.artifacts[1]!.pin).toBe('2.1.x');
  });

  it('excludes prereleases unless enabled', () => {
    const results = [result('a', artifact('corp.linter', '2.0.0-beta.1', '1.3.0'))];
    expect(compute({ results, installedVersion }).artifacts[0]!.status).toBe('up-to-date');
    const withPre = compute({ results, installedVersion, includePrerelease: true });
    expect(withPre.artifacts[0]).toMatchObject({
      status: 'update',
      latest: { version: '2.0.0-beta.1' },
    });
  });

  it('falls back to the installed display name when sources report none', () => {
    const state = compute({
      results: [result('a', { ...artifact('corp.linter', '1.4.1'), displayName: undefined })],
      installedVersion,
      displayName: (id) => (id === 'corp.linter' ? 'Corp Linter' : undefined),
    });
    expect(state.artifacts[0]!.displayName).toBe('Corp Linter');
  });

  it('marks skipped versions', () => {
    const state = compute({
      results: [result('a', artifact('corp.linter', '1.4.1'))],
      installedVersion,
      isSkipped: (id, v) => id === 'corp.linter' && v === '1.4.1',
    });
    expect(state.artifacts[0]!.status).toBe('skipped');
  });

  it('reports source errors, missing artifacts and unknown sources as problems', () => {
    const state = compute({
      results: [
        result('a', artifact('corp.linter', '1.4.1')),
        { ...result('broken'), error: 'Folder not found: /x' },
      ],
      tracking: tracking('corp.linter', 'corp.gone', 'nope:corp.linter2', {
        id: 'corp.linter',
        pin: '9.x',
      }),
      installedVersion,
      configProblems: [{ source: 'bad', message: 'Invalid source "bad"' }],
    });
    expect(state.problems.map((p) => p.message)).toEqual([
      'Invalid source "bad"',
      'broken: Folder not found: /x',
      'corp.linter2: source "nope" is not configured or disabled',
      'corp.gone is not offered by any source',
      'corp.linter2 is not offered by source "nope"',
    ]);
    // The first tracking entry for an ID wins, so the pin entry was dropped.
    expect(state.artifacts.map((a) => a.id)).toEqual(['corp.linter']);
  });

  it('reports a pin that matches nothing', () => {
    const state = compute({
      results: [result('a', artifact('corp.linter', '1.4.1'))],
      tracking: tracking({ id: 'corp.linter', pin: '9.x' }),
      installedVersion,
    });
    expect(state.problems.map((p) => p.message)).toEqual([
      'corp.linter: no version matches pin "9.x" (prereleases excluded)',
    ]);
  });
});

describe('listAll', () => {
  function fakeSource(name: string, list: Source['list']): Source {
    return { name, type: 'file', list, download: () => Promise.reject(new Error('unused')) };
  }

  it('runs sources in parallel, filters, and isolates failures and timeouts', async () => {
    const results = await listAll(
      [
        {
          source: fakeSource('ok', async () => [
            artifact('corp.a', '1.0.0'),
            artifact('other.b', '1.0.0'),
          ]),
          timeoutMs: 1000,
          include: ['corp.*'],
          exclude: [],
        },
        {
          source: fakeSource('fails', () => Promise.reject(new Error('boom'))),
          timeoutMs: 1000,
          include: [],
          exclude: [],
        },
        {
          // Ignores its token on purpose: the timeout must still win.
          source: fakeSource('hangs', () => new Promise<Artifact[]>(() => undefined)),
          timeoutMs: 20,
          include: [],
          exclude: [],
        },
      ],
      NEVER_CANCELLED,
      NULL_LOGGER,
    );
    expect(results.map((r) => [r.source, r.artifacts.map((a) => a.id), r.error])).toEqual([
      ['ok', ['corp.a'], undefined],
      ['fails', [], 'boom'],
      ['hangs', [], 'Source "hangs" timed out after 0 s'],
    ]);
  });

  it('passes cancellation through to sources', async () => {
    const cts = new CancellationSource();
    const pending = listAll(
      [
        {
          source: fakeSource(
            'slow',
            (token) =>
              new Promise((_, reject) => {
                token.onCancellationRequested(() => reject(new Error('saw cancel')));
              }),
          ),
          timeoutMs: 10_000,
          include: [],
          exclude: [],
        },
      ],
      cts.token,
      NULL_LOGGER,
    );
    cts.cancel();
    const [r] = await pending;
    expect(r!.error).toMatch(/cancel/i);
  });
});
