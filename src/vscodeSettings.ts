/**
 * Reads raw `leuchtturm.*` values from VS Code. This is the only place that decides which
 * settings scopes are trusted (SPEC §5, §6.5, §9).
 */

import * as vscode from 'vscode';

import type { RawSettings } from './config';

export const SECTION = 'leuchtturm';

/**
 * Settings that can make Leuchtturm download or execute something. They are read from the
 * user (global) level only, never from workspace or folder settings, so a cloned repository's
 * `.vscode/settings.json` cannot inject a source or turn on scripts. `"scope": "machine"` in
 * package.json already makes VS Code ignore workspace values; this is defence in depth.
 */
const USER_ONLY = new Set(['sources', 'script.enabled']);

export function readRawSettings(): RawSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return (key) => {
    if (USER_ONLY.has(key)) {
      const inspected = cfg.inspect(key);
      return inspected?.globalValue ?? inspected?.defaultValue;
    }
    return cfg.get(key);
  };
}
