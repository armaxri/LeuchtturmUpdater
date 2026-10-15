/**
 * Periodic checks: one check shortly after startup, then every `checkInterval` minutes.
 * The cross-window lock and error back-off (SPEC §8) come in milestone M2.
 */

import type { Settings } from './config';

export const STARTUP_DELAY_MS = 10_000;

export class Scheduler {
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private intervalMinutes = 0;

  constructor(private readonly runCheck: () => void) {}

  /** Starts the timers. `startup` is true only on activation. */
  start(settings: Settings, startup: boolean): void {
    if (startup && settings.enabled && settings.checkOnStartup) {
      this.startupTimer = setTimeout(() => this.runCheck(), STARTUP_DELAY_MS);
    }
    this.reschedule(settings);
  }

  /** Applies changed interval settings. A no-op if nothing relevant changed. */
  reschedule(settings: Settings): void {
    const minutes = settings.enabled ? settings.checkIntervalMinutes : 0;
    if (minutes === this.intervalMinutes) {
      return;
    }
    this.stopInterval();
    this.intervalMinutes = minutes;
    if (minutes > 0) {
      this.intervalTimer = setInterval(() => this.runCheck(), minutes * 60_000);
    }
  }

  private stopInterval(): void {
    if (this.intervalTimer !== undefined) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
  }

  dispose(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer);
    }
    this.stopInterval();
  }
}
