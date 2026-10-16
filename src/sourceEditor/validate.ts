/**
 * Checks a source being edited with the same parser the checks use (config.ts), so the editor
 * and the real check never disagree. Runs in the extension, not in the webview.
 */

import { parseConfig, referencedSecrets } from '../config';
import { SOURCE_NAME } from './formSpec';
import type { Validation } from './protocol';
import { getPath, type RawSource } from './values';

export type { Validation };

export interface ValidationContext {
  /** Names of the other sources (a name must be unique). */
  otherNames: readonly string[];
  /** Credential names in VS Code's secret storage. */
  storedSecrets: readonly string[];
  /** `leuchtturm.script.enabled` (user level). */
  scriptEnabled: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Fields that should hold `${secret:NAME}` rather than the password itself. */
const CREDENTIAL_PATHS = ['auth.basic.password', 'auth.bearer', 'auth.token'];

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
  // reported separately below. Unknown credentials get a placeholder, so a missing one is a
  // warning, not a parse error.
  const secrets = Object.fromEntries(referencedSecrets(raw).map((s) => [s, 'placeholder']));
  const settings: Record<string, unknown> = {
    sources: { [name || 'draft']: { ...raw, enabled: true } },
    'script.enabled': true,
  };
  const config = parseConfig((key) => settings[key], { secrets, env: ctx.env });
  for (const p of config.problems) {
    // "Invalid source "x": …" → just the reason; the editor shows which source it is.
    errors.push(p.message.replace(/^Invalid source "[^"]*": /, ''));
  }

  for (const secret of referencedSecrets(raw)) {
    if (!ctx.storedSecrets.includes(secret)) {
      warnings.push(`The credential "${secret}" is not stored yet. Use "Store credential…".`);
    }
  }
  for (const path of CREDENTIAL_PATHS) {
    const value = getPath(raw, path);
    if (typeof value === 'string' && value !== '' && !value.includes('${')) {
      warnings.push(
        `${path} is stored as plain text in settings.json. Prefer a stored credential.`,
      );
    }
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
