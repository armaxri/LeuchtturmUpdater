/**
 * Lists a source configuration with the real source implementation, outside VS Code: what
 * `Controller.listDraft` does for the source editor. For tests of "Add Source" (discover.ts).
 */

import { parseConfig } from '../config';
import { NULL_LOGGER } from '../log';
import type { RawSource } from '../sourceEditor/values';
import { createSource } from '../sources';
import type { Source } from '../sources/types';
import { NEVER_CANCELLED } from '../util/cancellation';

export function draftSource(name: string, raw: RawSource): Source {
  const config = parseConfig((key) => (key === 'sources' ? { [name]: raw } : undefined));
  const parsed = config.sources[0];
  if (!parsed) {
    throw new Error(config.problems[0]?.message ?? 'The source is disabled');
  }
  return createSource(parsed, NULL_LOGGER, {
    timeoutMs: 30_000,
    script: {
      gate: { enabled: () => false, isApproved: () => false, requestApproval: () => undefined },
      schema: {},
      hostVersion: '1.99.0',
    },
  });
}

export function listDraft(name: string, raw: RawSource) {
  return draftSource(name, raw).list(NEVER_CANCELLED);
}
