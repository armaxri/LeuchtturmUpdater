/**
 * What is installed on the remote side of a remote window, as reported by the remote helper
 * (see src/helper/protocol.ts). Free of `vscode` imports so it can be unit tested; the target
 * passes in how to ask the helper.
 */

import { parseHelperResponse, type InstalledExtension } from '../helper/protocol';
import type { ProblemAction } from '../sources/types';
import { compareVersions } from '../version';
import type { TargetProblem } from './types';

export const INSTALL_HELPER_COMMAND = 'leuchtturm.installRemoteHelper';

export type RemoteHelperStatus =
  /** Not a remote window: nothing to do. */
  | 'local'
  | 'ok'
  | 'missing'
  /** Installed, but older than the helper shipped with this Leuchtturm. */
  | 'outdated';

export interface RemoteHost {
  /** `vscode.env.remoteName`, e.g. `dev-container`, `ssh-remote`, `wsl`. */
  remoteName(): string | undefined;
  /** Runs the helper's command; rejects if no extension provides it. */
  query(): Promise<unknown>;
}

const REMOTE_LABELS: Record<string, string> = {
  'dev-container': 'the dev container',
  'attached-container': 'the container',
  'ssh-remote': 'the SSH host',
  wsl: 'WSL',
  tunnel: 'the tunnel host',
  codespaces: 'the codespace',
};

/** "the dev container", "the SSH host", … for messages. */
export function remoteLabel(remoteName: string): string {
  return REMOTE_LABELS[remoteName] ?? `the remote side (${remoteName})`;
}

export class RemoteExtensions {
  private installed = new Map<string, InstalledExtension>();
  private current: RemoteHelperStatus = 'local';

  constructor(
    private readonly host: RemoteHost,
    /** Version of the helper shipped with this Leuchtturm. */
    private readonly bundledVersion: string,
  ) {}

  get status(): RemoteHelperStatus {
    return this.current;
  }

  /** Asks the helper again. Never throws: a failing helper counts as missing. */
  async refresh(): Promise<RemoteHelperStatus> {
    if (!this.host.remoteName()) {
      this.installed.clear();
      this.current = 'local';
      return this.current;
    }
    let answer: unknown;
    try {
      answer = await this.host.query();
    } catch {
      answer = undefined;
    }
    const response = parseHelperResponse(answer);
    if (!response) {
      this.installed.clear();
      this.current = 'missing';
      return this.current;
    }
    this.installed = new Map(response.extensions.map((e) => [e.id.toLowerCase(), e]));
    this.current =
      compareVersions(response.helperVersion, this.bundledVersion) < 0 ? 'outdated' : 'ok';
    return this.current;
  }

  get(id: string): InstalledExtension | undefined {
    return this.installed.get(id.toLowerCase());
  }

  /** A problem node for the sidebar while the helper is missing or outdated. */
  problem(): TargetProblem | undefined {
    const remoteName = this.host.remoteName();
    if (!remoteName || (this.current !== 'missing' && this.current !== 'outdated')) {
      return undefined;
    }
    const where = remoteLabel(remoteName);
    const action: ProblemAction = {
      title: this.current === 'missing' ? 'Install Helper…' : 'Update Helper…',
      command: INSTALL_HELPER_COMMAND,
    };
    return {
      message:
        this.current === 'missing'
          ? `Extensions installed in ${where} are not visible yet. Click to install the ` +
            `Leuchtturm helper there.`
          : `The Leuchtturm helper in ${where} is outdated. Click to update it.`,
      action,
    };
  }
}
