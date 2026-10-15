import type { ArtifactKind } from '../sources/types';

/**
 * Where an artifact gets installed. `VsCodeExtensionTarget` is the only v1 implementation;
 * the planned `directory` target (SPEC §13) will implement the same interface.
 */
export interface Target {
  readonly kind: ArtifactKind;
  /** The installed version, or undefined if the artifact is not installed. */
  getInstalledVersion(id: string): string | undefined;
  /** Installs a downloaded artifact (a file or directory path). */
  install(downloadedPath: string, id: string, version: string): Promise<void>;
}
