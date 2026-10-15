import type { SourceConfig } from '../config';
import type { Logger } from '../log';
import { FileSource } from './fileSource';
import { HttpSource } from './httpSource';
import type { Source } from './types';

export interface SourceDefaults {
  /** Used when a source sets no `timeout`. */
  timeoutMs: number;
}

/** Creates the implementation for a validated source config. */
export function createSource(config: SourceConfig, log: Logger, defaults: SourceDefaults): Source {
  const timeoutMs = config.timeoutSeconds ? config.timeoutSeconds * 1000 : defaults.timeoutMs;
  switch (config.type) {
    case 'file':
      return new FileSource(config, log);
    case 'http':
      return new HttpSource(config, timeoutMs, log);
  }
}
