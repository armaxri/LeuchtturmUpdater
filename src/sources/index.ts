import type { SourceConfig } from '../config';
import type { Logger } from '../log';
import { FileSource } from './fileSource';
import { HttpSource } from './httpSource';
import { NpmSource } from './npmSource';
import type { Source } from './types';

export interface SourceDefaults {
  /** Used when a source sets no `timeout`. */
  timeoutMs: number;
  /** Registers a credential a source found on its own (e.g. in `.npmrc`) for log redaction. */
  addSecret: (value: string) => void;
}

/** Creates the implementation for a validated source config. */
export function createSource(config: SourceConfig, log: Logger, defaults: SourceDefaults): Source {
  const timeoutMs = config.timeoutSeconds ? config.timeoutSeconds * 1000 : defaults.timeoutMs;
  switch (config.type) {
    case 'file':
      return new FileSource(config, log);
    case 'http':
      return new HttpSource(config, timeoutMs, log);
    case 'npm':
      return new NpmSource(config, timeoutMs, log, defaults.addSecret);
  }
}
