import type { ArtifactKind } from '../sources/types';

/**
 * Where an artifact gets installed. `VsCodeExtensionTarget` is the only v1 implementation;
 * the planned `directory` target (SPEC §13) will implement the same interface.
 */
export interface Target {
  readonly kind: ArtifactKind;
  /** The installed version, or undefined if the artifact is not installed. */
  getInstalledVersion(id: string): string | undefined;
  /** Human-readable name of an installed artifact, if the target knows one. */
  getDisplayName?(id: string): string | undefined;
  /**
   * Checks the downloaded artifact before installing (SPEC §9.4). Throws if it is not what
   * was offered; returns a question for the user if it is acceptable only with confirmation.
   */
  verify?(downloadedPath: string, id: string, version: string): Promise<{ confirm?: string }>;
  /** Installs a downloaded artifact (a file or directory path). */
  install(downloadedPath: string, id: string, version: string): Promise<void>;
}
