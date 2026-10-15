import { describe, expect, it } from 'vitest';

import { secretStorageKey, StateStore } from '../../src/state';
import { MemoryMemento } from './helpers';

describe('StateStore', () => {
  it('remembers announced versions case-insensitively', async () => {
    const store = new StateStore(new MemoryMemento());
    expect(store.isAnnounced('corp.linter', '1.4.1')).toBe(false);
    await store.markAnnounced([{ id: 'Corp.Linter', version: '1.4.1' }]);
    await store.markAnnounced([{ id: 'corp.linter', version: '1.4.1' }]);
    expect(store.isAnnounced('corp.linter', '1.4.1')).toBe(true);
    expect(store.isAnnounced('corp.linter', '1.4.2')).toBe(false);
  });

  it('skips one version per artifact and can reset', async () => {
    const store = new StateStore(new MemoryMemento());
    await store.skip('corp.linter', '1.4.1');
    expect(store.isSkipped('CORP.linter', '1.4.1')).toBe(true);
    expect(store.isSkipped('corp.linter', '1.4.2')).toBe(false);
    await store.skip('corp.linter', '1.4.2');
    expect(store.isSkipped('corp.linter', '1.4.1')).toBe(false);
    await store.clearSkipped();
    expect(store.isSkipped('corp.linter', '1.4.2')).toBe(false);
  });

  it('hands out install leases per id and respects other windows', async () => {
    const store = new StateStore(new MemoryMemento());
    expect(await store.acquireInstall('corp.a', 'w1', 0, 1000)).toBe(true);
    expect(await store.acquireInstall('CORP.A', 'w2', 500, 1000)).toBe(false);
    expect(await store.acquireInstall('corp.b', 'w2', 500, 1000)).toBe(true);
    // Expired leases are free again.
    expect(await store.acquireInstall('corp.a', 'w2', 1500, 1000)).toBe(true);
    await store.releaseInstall('corp.a', 'w1'); // not the owner any more: no effect
    expect(await store.acquireInstall('corp.a', 'w1', 1600, 1000)).toBe(false);
    await store.releaseInstall('corp.a', 'w2');
    expect(await store.acquireInstall('corp.a', 'w1', 1600, 1000)).toBe(true);
  });
});

describe('secretStorageKey', () => {
  it('namespaces secret names', () => {
    expect(secretStorageKey('jenkins-basic')).toBe('leuchtturm.secret.jenkins-basic');
  });
});
