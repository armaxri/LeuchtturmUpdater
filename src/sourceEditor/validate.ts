/**
 * Checks a source being edited with the same parser the checks use (config.ts), so the editor
 * and the real check never disagree. Runs in the extension, not in the webview.
 */

import { parseConfig } from '../config';
import { SOURCE_NAME } from './formSpec';
import type { Validation } from './protocol';
import type { RawSource } from './values';

export type { Validation };

export interface ValidationContext {
  /** Names of the other sources (a name must be unique). */
  otherNames: readonly string[];
  /** `leuchtturm.script.enabled` (user level). */
  scriptEnabled: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

export function validateSource(name: string, raw: RawSource, ctx: ValidationContext): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!name.trim()) {
    errors.push('Give the source a name.');
  } else if (!SOURCE_NAME.test(name)) {
    errors.push('Name: use letters, digits, "-", "_" and "." only.');
  } else if (ctx.otherNames.includes(name)) {
    errors.push(`There is already a source named "${name}".`);
  }

  // Validate the structure as if the source were enabled and scripts allowed; both are
  // reported separately below.
  const settings: Record<string, unknown> = {
    sources: { [name || 'draft']: { ...raw, enabled: true } },
    'script.enabled': true,
  };
  const config = parseConfig((key) => settings[key], { env: ctx.env });
  for (const p of config.problems) {
    // "Invalid source "x": …" → just the reason; the editor shows which source it is.
    errors.push(p.message.replace(/^Invalid source "[^"]*": /, ''));
  }

  if (raw.type === 'script' && !ctx.scriptEnabled) {
    warnings.push(
      'Script sources are turned off. Enable "leuchtturm.script.enabled" in your user settings to use this source.',
    );
  }
  if (raw.enabled === false) {
    warnings.push('This source is disabled and will not be checked.');
  }
  return { errors, warnings };
}
