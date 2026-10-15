/**
 * Core types shared by all sources. Named generically (`Artifact`, not `Extension`) so that
 * targets other than VS Code extensions can be added later (SPEC §13).
 */

import type { CancellationToken } from '../util/cancellation';

export type { CancellationToken } from '../util/cancellation';

/** What an artifact installs as. Only VS Code extensions exist in v1. */
export type ArtifactKind = 'vscode-extension';

export type SourceType = 'file' | 'npm' | 'http' | 'script';

export const SOURCE_TYPES: readonly SourceType[] = ['file', 'npm', 'http', 'script'];

export interface AvailableVersion {
  /** Semver. */
  version: string;
  /** Markdown or plain text. */
  releaseNotes?: string;
  releaseNotesUrl?: string;
  /** Optional integrity check, hex encoded. */
  sha256?: string;
  /** Opaque, source-specific data needed for download (file path, captured groups, URL...). */
  ref: Record<string, string>;
}

export interface Artifact {
  /** `publisher.name` for VS Code extensions. */
  id: string;
  displayName?: string;
  kind: ArtifactKind;
  /** Sorted newest first. */
  versions: AvailableVersion[];
}

export interface Source {
  readonly name: string;
  readonly type: SourceType;
  list(token: CancellationToken): Promise<Artifact[]>;
  /**
   * Downloads `version` into `targetDir` and returns the absolute path of the result.
   * For VS Code extensions this is a `.vsix` file. Future kinds may return a directory.
   */
  download(
    artifact: Artifact,
    version: AvailableVersion,
    targetDir: string,
    token: CancellationToken,
  ): Promise<string>;
}
