/**
 * Persistent state in `globalState`: announced and skipped versions, the cached result of the
 * last check, and the leases that coordinate several VS Code windows (SPEC §8).
 *
 * `globalState` is shared by all windows of a VS Code installation; a value written in one
 * window becomes visible in the others after a short delay. `Memento` is VS Code's key-value
 * store type; we only depend on its shape so this module stays unit-testable.
 */

import type { SourceResult } from './checker';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * SecretStorage key for `${secret:NAME}`. Namespaced so internal keys added later can never
 * collide with user-chosen names. Changing this orphans every stored credential.
 */
export function secretStorageKey(name: string): string {
  return `leuchtturm.secret.${name}`;
}

const ANNOUNCED = 'leuchtturm.announced';
const SKIPPED = 'leuchtturm.skipped';
const CACHE = 'leuchtturm.cache';
const CHECK_LEASE = 'leuchtturm.checkLease';
const INSTALL_LEASES = 'leuchtturm.installLeases';
const APPROVED_SCRIPTS = 'leuchtturm.approvedScripts';

/** "Window `owner` holds this until `until` (epoch ms)." Expired leases are free to take. */
export interface Lease {
  owner: string;
  until: number;
}

export interface SourceFailure {
  /** Consecutive failed attempts. */
  count: number;
  lastAttempt: number;
}

/** The last check's raw results, shared with the other windows. */
export interface CachedCheck {
  /** When the last full check finished. Partial (retry) checks don't move it. */
  checkedAt: number;
  /** When any check last changed the cache; other windows reload when it moves. */
  updatedAt: number;
  results: SourceResult[];
  failures: Record<string, SourceFailure>;
}

/** Keeps the announced list bounded; old entries only matter for versions still offered. */
const MAX_ANNOUNCED = 500;

function key(id: string, version: string): string {
  return `${id.toLowerCase()}@${version}`;
}

export class StateStore {
  constructor(private readonly memento: MementoLike) {}

  isAnnounced(id: string, version: string): boolean {
    return (this.memento.get<string[]>(ANNOUNCED) ?? []).includes(key(id, version));
  }

  async markAnnounced(items: readonly { id: string; version: string }[]): Promise<void> {
    const list = this.memento.get<string[]>(ANNOUNCED) ?? [];
    const merged = [...list, ...items.map((i) => key(i.id, i.version))];
    await this.memento.update(ANNOUNCED, [...new Set(merged)].slice(-MAX_ANNOUNCED));
  }

  isSkipped(id: string, version: string): boolean {
    return this.memento.get<Record<string, string>>(SKIPPED)?.[id.toLowerCase()] === version;
  }

  /** Skips one version of an artifact. A newer version shows up as an update again. */
  async skip(id: string, version: string): Promise<void> {
    const skipped = { ...(this.memento.get<Record<string, string>>(SKIPPED) ?? {}) };
    skipped[id.toLowerCase()] = version;
    await this.memento.update(SKIPPED, skipped);
  }

  async clearSkipped(): Promise<void> {
    await this.memento.update(SKIPPED, undefined);
  }

  /** Script approvals, by fingerprint of command + script path (SPEC §6.5). */
  isScriptApproved(fingerprint: string): boolean {
    return (this.memento.get<string[]>(APPROVED_SCRIPTS) ?? []).includes(fingerprint);
  }

  async approveScript(fingerprint: string): Promise<void> {
    const list = this.memento.get<string[]>(APPROVED_SCRIPTS) ?? [];
    if (!list.includes(fingerprint)) {
      await this.memento.update(APPROVED_SCRIPTS, [...list, fingerprint]);
    }
  }

  get cache(): CachedCheck | undefined {
    return this.memento.get<CachedCheck>(CACHE);
  }

  async setCache(cache: CachedCheck): Promise<void> {
    await this.memento.update(CACHE, cache);
  }

  get checkLease(): Lease | undefined {
    return this.memento.get<Lease>(CHECK_LEASE);
  }

  async setCheckLease(lease: Lease | undefined): Promise<void> {
    await this.memento.update(CHECK_LEASE, lease);
  }

  /**
   * Takes the install lease for `id` unless another window holds a valid one. Returns false
   * if it is taken. Not atomic across windows, but installs are rare, user-started events.
   */
  async acquireInstall(id: string, owner: string, now: number, ttlMs: number): Promise<boolean> {
    const leases = { ...(this.memento.get<Record<string, Lease>>(INSTALL_LEASES) ?? {}) };
    const current = leases[id.toLowerCase()];
    if (current && current.owner !== owner && current.until > now) {
      return false;
    }
    // Drop expired entries so the record does not grow forever.
    for (const [k, v] of Object.entries(leases)) {
      if (v.until <= now) {
        delete leases[k];
      }
    }
    leases[id.toLowerCase()] = { owner, until: now + ttlMs };
    await this.memento.update(INSTALL_LEASES, leases);
    return true;
  }

  async releaseInstall(id: string, owner: string): Promise<void> {
    const leases = { ...(this.memento.get<Record<string, Lease>>(INSTALL_LEASES) ?? {}) };
    if (leases[id.toLowerCase()]?.owner === owner) {
      delete leases[id.toLowerCase()];
      await this.memento.update(INSTALL_LEASES, leases);
    }
  }
}
