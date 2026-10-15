import { Redactor } from './util/redact';

/** Logging interface used by core code. Implemented on top of a VS Code `LogOutputChannel`. */
export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string | Error): void;
}

/** Wraps any logger so that every line passes through the redactor first. */
export class RedactingLogger implements Logger {
  constructor(
    private readonly inner: Logger & { show?(preserveFocus?: boolean): void },
    readonly redactor: Redactor,
  ) {}

  /** Reveals the underlying output channel, if there is one. */
  show(): void {
    this.inner.show?.(true);
  }

  trace(message: string): void {
    this.inner.trace(this.redactor.redact(message));
  }
  debug(message: string): void {
    this.inner.debug(this.redactor.redact(message));
  }
  info(message: string): void {
    this.inner.info(this.redactor.redact(message));
  }
  warn(message: string): void {
    this.inner.warn(this.redactor.redact(message));
  }
  error(message: string | Error): void {
    const text = message instanceof Error ? (message.stack ?? message.message) : message;
    this.inner.error(this.redactor.redact(text));
  }
}

/** Discards everything. Handy default for tests. */
export const NULL_LOGGER: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
