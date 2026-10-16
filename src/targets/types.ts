import type { ArtifactKind, ProblemAction } from '../sources/types';

/** A problem the target itself reports, e.g. a missing remote helper. */
export interface TargetProblem {
  message: string;
  action?: ProblemAction;
}

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
   * Re-reads installed versions that need an asynchronous lookup (the remote side of a
   * remote window). Called before every check. Must not throw.
   */
  refresh?(): Promise<void>;
  /** Problems to show in the sidebar, e.g. "install the remote helper". */
  problems?(): TargetProblem[];
  /**
   * Checks the downloaded artifact before installing (SPEC §9.4). Throws if it is not what
   * was offered; returns a question for the user if it is acceptable only with confirmation.
   */
  verify?(downloadedPath: string, id: string, version: string): Promise<{ confirm?: string }>;
  /** Installs a downloaded artifact (a file or directory path). */
  install(downloadedPath: string, id: string, version: string): Promise<void>;
}
