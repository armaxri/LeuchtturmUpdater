import type { SourceConfig } from '../config';
import type { Logger } from '../log';
import { FileSource } from './fileSource';
import type { Source } from './types';

/** Creates the implementation for a validated source config. */
export function createSource(config: SourceConfig, log: Logger): Source {
  switch (config.type) {
    case 'file':
      return new FileSource(config, log);
  }
}
