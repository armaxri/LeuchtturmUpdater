/**
 * A cancellation token shaped like `vscode.CancellationToken`, so core code can be unit-tested
 * without the `vscode` module. A real VS Code token is structurally assignable to this type.
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: (e: unknown) => unknown): { dispose(): unknown };
}

export class CancelledError extends Error {
  override name = 'CancelledError';
  constructor(message = 'Cancelled') {
    super(message);
  }
}

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/** Owns a token that fires on `cancel()`, on parent cancellation, or after an optional timeout. */
export class CancellationSource {
  private cancelled = false;
  private readonly listeners = new Set<(e: unknown) => unknown>();
  private readonly cleanups: (() => void)[] = [];
  /** Set when the timeout (not the parent or `cancel()`) caused the cancellation. */
  timedOut = false;

  readonly token: CancellationToken;

  constructor(parent?: CancellationToken, timeoutMs?: number) {
    // The token is a view onto this source. Arrow functions capture `this`.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.token = {
      get isCancellationRequested() {
        return self.cancelled;
      },
      onCancellationRequested: (listener) => {
        if (this.cancelled) {
          queueMicrotask(() => listener(undefined));
          return { dispose: () => undefined };
        }
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      },
    };
    if (parent) {
      if (parent.isCancellationRequested) {
        this.cancelled = true;
      } else {
        const sub = parent.onCancellationRequested(() => this.cancel());
        this.cleanups.push(() => sub.dispose());
      }
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timer = setTimeout(() => {
        this.timedOut = true;
        this.cancel();
      }, timeoutMs);
      this.cleanups.push(() => clearTimeout(timer));
    }
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const l of this.listeners) {
      l(undefined);
    }
    this.listeners.clear();
  }

  dispose(): void {
    for (const c of this.cleanups) {
      c();
    }
    this.cleanups.length = 0;
    this.listeners.clear();
  }
}

export const NEVER_CANCELLED: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

export function throwIfCancelled(token: CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new CancelledError();
  }
}

/**
 * Runs `work` with a child token that is cancelled after `timeoutMs`. Rejects with
 * `TimeoutError` when the timeout fires first, even if `work` ignores its token.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  parent: CancellationToken,
  work: (token: CancellationToken) => Promise<T>,
  what = 'Operation',
): Promise<T> {
  const cts = new CancellationSource(parent, timeoutMs);
  try {
    const cancelled = new Promise<never>((_, reject) => {
      cts.token.onCancellationRequested(() =>
        reject(
          cts.timedOut
            ? new TimeoutError(`${what} timed out after ${Math.round(timeoutMs / 1000)} s`)
            : new CancelledError(),
        ),
      );
    });
    return await Promise.race([work(cts.token), cancelled]);
  } finally {
    cts.dispose();
  }
}
