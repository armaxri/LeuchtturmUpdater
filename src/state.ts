/**
 * Persistent state in `globalState`: which updates were already announced, skipped versions
 * and the last check time. `Memento` is VS Code's key-value store; we only depend on its shape.
 */

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
const LAST_CHECK = 'leuchtturm.lastCheck';

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

  get lastCheck(): number | undefined {
    return this.memento.get<number>(LAST_CHECK);
  }

  async setLastCheck(time: number): Promise<void> {
    await this.memento.update(LAST_CHECK, time);
  }
}
