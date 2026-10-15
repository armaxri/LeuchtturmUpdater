import { describe, expect, it } from 'vitest';

import { StateStore, type MementoLike } from '../../src/state';

class MemoryMemento implements MementoLike {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

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

  it('stores the last check time', async () => {
    const store = new StateStore(new MemoryMemento());
    expect(store.lastCheck).toBeUndefined();
    await store.setLastCheck(42);
    expect(store.lastCheck).toBe(42);
  });
});
