/**
 * The contract between Leuchtturm and its remote helper (src/helper/extension.ts).
 *
 * In a remote window (Dev Containers, SSH, WSL), Leuchtturm runs on the local machine, but
 * most extensions are installed on the remote side. `vscode.extensions` only lists the
 * extensions of the calling extension host, so Leuchtturm cannot see them. The helper runs on
 * the remote side and answers one command with what is installed there. Commands work across
 * extension hosts, and their results are passed as JSON.
 */

export const HELPER_ID = 'armaxri.leuchtturm-remote-helper';
export const HELPER_COMMAND = 'leuchtturm.remoteHelper.installedExtensions';
export const HELPER_PROTOCOL = 1;
/** File name of the helper package inside Leuchtturm's `dist/` folder. */
export const HELPER_VSIX = 'leuchtturm-remote-helper.vsix';

export interface InstalledExtension {
  id: string;
  version: string;
  displayName?: string;
}

export interface HelperResponse {
  protocol: typeof HELPER_PROTOCOL;
  helperVersion: string;
  extensions: InstalledExtension[];
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** Validates a helper answer; `undefined` if it is missing or from an unknown protocol. */
export function parseHelperResponse(value: unknown): HelperResponse | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    v.protocol !== HELPER_PROTOCOL ||
    !isString(v.helperVersion) ||
    !Array.isArray(v.extensions)
  ) {
    return undefined;
  }
  const extensions: InstalledExtension[] = [];
  for (const item of v.extensions as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const e = item as Record<string, unknown>;
    if (isString(e.id) && isString(e.version)) {
      extensions.push({
        id: e.id,
        version: e.version,
        ...(isString(e.displayName) ? { displayName: e.displayName } : {}),
      });
    }
  }
  return { protocol: HELPER_PROTOCOL, helperVersion: v.helperVersion, extensions };
}
