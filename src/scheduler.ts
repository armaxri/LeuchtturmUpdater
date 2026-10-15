/**
 * Periodic checks coordinated across VS Code windows (SPEC §8).
 *
 * Every window ticks once a minute. The window holding the check lease (stored in the shared
 * `globalState`) is the only one that checks; the others pick up its cached results. The lease
 * expires if its window closes or hangs, and another window takes over at its next tick.
 * Failing sources are retried with exponential back-off: `min(interval, 5 min × 2^(n-1))`.
 * A manual "Check now" bypasses all of this and always runs.
 */

import type { Settings } from './config';
import type { Logger } from './log';
import type { CachedCheck, Lease, StateStore } from './state';

export const STARTUP_DELAY_MS = 10_000;
export const TICK_MS = 60_000;
/** Long enough to survive a few missed ticks, short enough for a quick takeover. */
export const LEASE_TTL_MS = 3 * TICK_MS;
export const BACKOFF_BASE_MS = 5 * 60_000;

export function backoffMs(failures: number, intervalMs: number): number {
  return Math.min(intervalMs, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** True if `me` may take or keep the lease. */
export function canLead(lease: Lease | undefined, me: string, now: number): boolean {
  return !lease || lease.owner === me || lease.until <= now;
}

/** `'all'`, the names of the sources to (re)check, or `'none'`. */
export type CheckPlan = 'none' | 'all' | string[];

export interface PlanInput {
  cache: CachedCheck | undefined;
  /** Configured, enabled sources. */
  sourceNames: readonly string[];
  /** 0 = periodic checks disabled (no back-off retries either). */
  intervalMs: number;
  now: number;
  /** First tick after activation with `checkOnStartup` on. */
  startupCheck: boolean;
}

/** Decides what the leading window should check now. Pure, so it is easy to test. */
export function planCheck(input: PlanInput): CheckPlan {
  const { cache, intervalMs, now } = input;
  if (input.startupCheck) {
    return 'all';
  }
  if (intervalMs <= 0) {
    return 'none';
  }
  if (!cache || now - cache.checkedAt >= intervalMs) {
    return 'all';
  }
  const known = new Set(cache.results.map((r) => r.source));
  const due = input.sourceNames.filter((name) => {
    if (!known.has(name)) {
      return true; // added since the last check
    }
    const failure = cache.failures[name];
    return (
      failure !== undefined && now - failure.lastAttempt >= backoffMs(failure.count, intervalMs)
    );
  });
  return due.length > 0 ? due : 'none';
}

/** What the scheduler needs from the rest of the extension. */
export interface SchedulerHost {
  settings(): Settings;
  sourceNames(): string[];
  /** Runs a background check of all or some sources. */
  check(plan: 'all' | string[]): Promise<void>;
  /** Loads results another window wrote to the cache, if they are newer than ours. */
  adoptCache(): void;
}

export class Scheduler {
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly host: SchedulerHost,
    private readonly store: StateStore,
    /** Identifies this window, e.g. `vscode.env.sessionId`. */
    private readonly windowId: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    // A little jitter makes it unlikely that windows restored together tick in lock-step.
    const delay = STARTUP_DELAY_MS + Math.floor(Math.random() * 2000);
    this.startupTimer = setTimeout(() => {
      void this.tick(true);
      this.tickTimer = setInterval(() => void this.tick(false), TICK_MS);
    }, delay);
  }

  /** One scheduling step. Public for tests. */
  async tick(startup: boolean): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const settings = this.host.settings();
      this.host.adoptCache();
      if (!settings.enabled) {
        return;
      }
      const now = this.now();
      const lease = this.store.checkLease;
      if (!canLead(lease, this.windowId, now)) {
        this.log.debug(
          `Another window leads update checks until ${new Date(lease!.until).toISOString()}`,
        );
        return;
      }
      await this.store.setCheckLease({ owner: this.windowId, until: now + LEASE_TTL_MS });
      const plan = planCheck({
        cache: this.store.cache,
        sourceNames: this.host.sourceNames(),
        intervalMs: settings.checkIntervalMinutes * 60_000,
        now,
        startupCheck: startup && settings.checkOnStartup,
      });
      if (plan !== 'none') {
        if (plan !== 'all') {
          this.log.info(`Retrying source(s): ${plan.join(', ')}`);
        }
        await this.host.check(plan);
      }
    } catch (err) {
      this.log.error(err instanceof Error ? err : String(err));
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    clearTimeout(this.startupTimer);
    clearInterval(this.tickTimer);
    // Hand over right away instead of letting the lease expire.
    if (this.store.checkLease?.owner === this.windowId) {
      void this.store.setCheckLease(undefined);
    }
  }
}
