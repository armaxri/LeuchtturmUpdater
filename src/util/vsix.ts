/**
 * Reads and checks the manifest inside a `.vsix` (SPEC §9.4): `extension/package.json` must
 * name the extension and version that the source offered.
 */

import { readZipEntry } from './zip';

export interface VsixManifest {
  publisher: string;
  name: string;
  version: string;
  /** `publisher.name` */
  id: string;
  displayName?: string;
}

export async function readVsixManifest(path: string): Promise<VsixManifest> {
  let data: Buffer | undefined;
  try {
    data = await readZipEntry(path, 'extension/package.json');
  } catch (err) {
    throw new Error(`Not a valid .vsix: ${(err as Error).message}`, { cause: err });
  }
  if (!data) {
    throw new Error('Not a valid .vsix: extension/package.json is missing');
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Not a valid .vsix: extension/package.json is not JSON');
  }
  const { publisher, name, version, displayName } = json;
  if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('Not a valid .vsix: package.json lacks publisher, name or version');
  }
  return {
    publisher,
    name,
    version,
    id: `${publisher}.${name}`,
    displayName: typeof displayName === 'string' ? displayName : undefined,
  };
}

export type VsixCheck =
  | { ok: true; manifest: VsixManifest }
  /** Same extension name and version, but another publisher: needs the user's confirmation. */
  | { ok: false; publisherMismatch: true; manifest: VsixManifest };

/**
 * Verifies that the VSIX contains `expectedId` at `expectedVersion`. Throws if the name or
 * version differ; a differing publisher alone is returned for confirmation (SPEC §9.6).
 */
export async function verifyVsix(
  path: string,
  expectedId: string,
  expectedVersion: string,
): Promise<VsixCheck> {
  const manifest = await readVsixManifest(path);
  const expectedName = expectedId.slice(expectedId.indexOf('.') + 1).toLowerCase();
  if (manifest.name.toLowerCase() !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(
      `The downloaded file contains ${manifest.id} ${manifest.version}, but ${expectedId} ${expectedVersion} was expected. Not installing it.`,
    );
  }
  if (manifest.id.toLowerCase() !== expectedId.toLowerCase()) {
    return { ok: false, publisherMismatch: true, manifest };
  }
  return { ok: true, manifest };
}
