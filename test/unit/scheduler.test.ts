import { describe, expect, it, vi } from 'vitest';

import { parseSettings } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import {
  backoffMs,
  BACKOFF_BASE_MS,
  canLead,
  LEASE_TTL_MS,
  planCheck,
  Scheduler,
  type SchedulerHost,
} from '../../src/scheduler';
import { StateStore, type CachedCheck } from '../../src/state';
import { MemoryMemento, settings } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;

function cache(overrides: Partial<CachedCheck> = {}): CachedCheck {
  return {
    checkedAt: 0,
    updatedAt: 0,
    results: [
      { source: 'a', type: 'file', artifacts: [], durationMs: 1 },
      { source: 'b', type: 'file', artifacts: [], durationMs: 1, error: 'down' },
    ],
    failures: { b: { count: 1, lastAttempt: 0 } },
    ...overrides,
  };
}

describe('backoffMs', () => {
  it('doubles from 5 minutes and is capped by the interval', () => {
    expect(backoffMs(1, HOUR)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2, HOUR)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(3, HOUR)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffMs(10, HOUR)).toBe(HOUR);
    expect(backoffMs(1, 3 * MIN)).toBe(3 * MIN);
  });
});

describe('canLead', () => {
  it('allows taking a free, own or expired lease', () => {
    expect(canLead(undefined, 'me', 0)).toBe(true);
    expect(canLead({ owner: 'me', until: 10 }, 'me', 100)).toBe(true);
    expect(canLead({ owner: 'other', until: 100 }, 'me', 100)).toBe(true);
    expect(canLead({ owner: 'other', until: 101 }, 'me', 100)).toBe(false);
  });
});

describe('planCheck', () => {
  const base = { sourceNames: ['a', 'b'], intervalMs: HOUR, startupCheck: false };

  it('checks everything on startup, without a cache, or when the interval elapsed', () => {
    expect(planCheck({ ...base, cache: cache(), now: 1, startupCheck: true })).toBe('all');
    expect(planCheck({ ...base, cache: undefined, now: 1 })).toBe('all');
    expect(planCheck({ ...base, cache: cache(), now: HOUR })).toBe('all');
  });

  it('retries failing sources after their back-off', () => {
    expect(planCheck({ ...base, cache: cache(), now: BACKOFF_BASE_MS - 1 })).toBe('none');
    expect(planCheck({ ...base, cache: cache(), now: BACKOFF_BASE_MS })).toEqual(['b']);
    const twice = cache({ failures: { b: { count: 2, lastAttempt: 0 } } });
    expect(planCheck({ ...base, cache: twice, now: BACKOFF_BASE_MS })).toBe('none');
    expect(planCheck({ ...base, cache: twice, now: 2 * BACKOFF_BASE_MS })).toEqual(['b']);
  });

  it('checks sources added since the last check', () => {
    expect(planCheck({ ...base, sourceNames: ['a', 'b', 'c'], cache: cache(), now: 1 })).toEqual([
      'c',
    ]);
  });

  it('does nothing periodic when the interval is 0', () => {
    expect(planCheck({ ...base, intervalMs: 0, cache: undefined, now: HOUR })).toBe('none');
    expect(
      planCheck({ ...base, intervalMs: 0, cache: undefined, now: 1, startupCheck: true }),
    ).toBe('all');
  });
});

describe('Scheduler.tick', () => {
  function setup(values: Record<string, unknown> = {}) {
    const store = new StateStore(new MemoryMemento());
    let now = 1_000_000;
    const host = {
      settings: () => parseSettings(settings(values)),
      sourceNames: () => ['a'],
      check: vi.fn<SchedulerHost['check']>(async () => {
        await store.setCache({ ...cache(), checkedAt: now, updatedAt: now, failures: {} });
      }),
      adoptCache: vi.fn(),
    };
    const make = (id: string) => new Scheduler(host, store, id, NULL_LOGGER, () => now);
    return { store, host, make, advance: (ms: number) => (now += ms), now: () => now };
  }

  it('lets only the lease holder check; the others adopt the cache', async () => {
    const { store, host, make } = setup();
    const w1 = make('w1');
    const w2 = make('w2');
    await w1.tick(true);
    expect(host.check).toHaveBeenCalledTimes(1);
    expect(store.checkLease?.owner).toBe('w1');

    await w2.tick(true);
    expect(host.check).toHaveBeenCalledTimes(1);
    expect(host.adoptCache).toHaveBeenCalledTimes(2);
  });

  it('takes over when the leader stops renewing', async () => {
    const { store, host, make, advance } = setup();
    await make('w1').tick(true);
    advance(LEASE_TTL_MS);
    await make('w2').tick(false);
    expect(store.checkLease?.owner).toBe('w2');
    // Not due yet: taking the lease does not mean checking again.
    expect(host.check).toHaveBeenCalledTimes(1);
    advance(HOUR);
    await make('w2').tick(false);
    expect(host.check).toHaveBeenCalledTimes(2);
  });

  it('releases the lease on dispose', async () => {
    const { store, make } = setup();
    const w1 = make('w1');
    await w1.tick(false);
    expect(store.checkLease?.owner).toBe('w1');
    w1.dispose();
    await Promise.resolve();
    expect(store.checkLease).toBeUndefined();
  });

  it('respects enabled and checkOnStartup', async () => {
    const off = setup({ enabled: false });
    await off.make('w1').tick(true);
    expect(off.host.check).not.toHaveBeenCalled();

    const noStartup = setup({ checkOnStartup: false });
    await noStartup.store.setCache({ ...cache(), checkedAt: noStartup.now(), failures: {} });
    await noStartup.make('w1').tick(true);
    expect(noStartup.host.check).not.toHaveBeenCalled();
  });
});
