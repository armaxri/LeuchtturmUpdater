/**
 * Download → verify → install (SPEC §4.3). This module has no UI; the extension wraps it with
 * progress, confirmations and the reload prompt.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Candidate } from './checker';
import { errorMessage, type Logger } from './log';
import type { Source } from './sources/types';
import type { Target } from './targets/types';
import { throwIfCancelled, type CancellationToken } from './util/cancellation';
import { verifySha256 } from './util/hash';

/** Cross-window install lock (SPEC §8): never install the same artifact from two windows. */
export interface InstallLock {
  acquire(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
}

const NO_LOCK: InstallLock = {
  acquire: async () => true,
  release: async () => undefined,
};

export class Installer {
  /** IDs with an install in progress in this window. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly downloadsDir: string,
    private readonly target: Target,
    private readonly log: Logger,
    private readonly lock: InstallLock = NO_LOCK,
  ) {}

  async install(source: Source, candidate: Candidate, token: CancellationToken): Promise<void> {
    const { artifact, available } = candidate;
    const id = artifact.id;
    const lock = id.toLowerCase();
    if (this.busy.has(lock)) {
      throw new Error(`${id} is already being installed`);
    }
    // Mark busy before the first `await`, so a second call in this window sees it.
    this.busy.add(lock);
    if (!(await this.lock.acquire(id))) {
      this.busy.delete(lock);
      throw new Error(`${id} is already being installed in another window`);
    }
    // A fresh folder per install, so parallel windows and leftovers never collide.
    const dir = path.join(this.downloadsDir, randomUUID());
    try {
      throwIfCancelled(token);
      this.log.info(`Installing ${id}@${available.version} from source "${source.name}"`);
      const file = await source.download(artifact, available, dir, token);
      throwIfCancelled(token);
      if (available.sha256) {
        await verifySha256(file, available.sha256);
        this.log.info(`SHA-256 verified for ${path.basename(file)}`);
      }
      await this.target.install(file, id, available.version);
      this.log.info(`Installed ${id}@${available.version}`);
    } finally {
      this.busy.delete(lock);
      await this.lock.release(id);
      await fs.rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
        this.log.warn(`Could not delete ${dir}: ${errorMessage(err)}`);
      });
    }
  }
}
