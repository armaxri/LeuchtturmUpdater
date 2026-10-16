import * as vscode from 'vscode';

import { HELPER_COMMAND } from '../helper/protocol';
import { verifyVsix } from '../util/vsix';
import { RemoteExtensions } from './remoteExtensions';
import type { Target, TargetProblem } from './types';

/** Installs `.vsix` files through VS Code's own (public) install command. */
export class VsCodeExtensionTarget implements Target {
  readonly kind = 'vscode-extension' as const;

  /**
   * Versions installed in this session. `vscode.extensions` keeps reporting the old version
   * until the window reloads, which would make the update show up again right after installing.
   */
  private readonly pending = new Map<string, string>();

  /**
   * In a remote window, `vscode.extensions` only lists the extensions running next to
   * Leuchtturm (locally). Extensions on the remote side are reported by the remote helper.
   */
  readonly remote: RemoteExtensions;

  constructor(
    /** The remote helper package shipped with Leuchtturm, and its version. */
    private readonly helper: { vsixPath: string; version: string },
  ) {
    this.remote = new RemoteExtensions(
      {
        remoteName: () => vscode.env.remoteName,
        query: () => Promise.resolve(vscode.commands.executeCommand<unknown>(HELPER_COMMAND)),
      },
      helper.version,
    );
  }

  getInstalledVersion(id: string): string | undefined {
    const pending = this.pending.get(id.toLowerCase());
    if (pending) {
      return pending;
    }
    const version: unknown = vscode.extensions.getExtension(id)?.packageJSON?.version;
    return typeof version === 'string' ? version : this.remote.get(id)?.version;
  }

  getDisplayName(id: string): string | undefined {
    const name: unknown = vscode.extensions.getExtension(id)?.packageJSON?.displayName;
    // Localized manifests use placeholders like `%displayName%`; those are no use here.
    return typeof name === 'string' && !name.startsWith('%')
      ? name
      : this.remote.get(id)?.displayName;
  }

  async refresh(): Promise<void> {
    await this.remote.refresh();
  }

  problems(): TargetProblem[] {
    const problem = this.remote.problem();
    return problem ? [problem] : [];
  }

  /**
   * Installs (or updates) the helper on the remote side. Its `extensionKind` is `workspace`,
   * so VS Code puts it there. Waits until it answers, which takes a moment after installing.
   */
  async installHelper(): Promise<boolean> {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(this.helper.vsixPath),
    );
    for (let i = 0; i < 30; i++) {
      if ((await this.remote.refresh()) === 'ok') {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async verify(downloadedPath: string, id: string, version: string): Promise<{ confirm?: string }> {
    const check = await verifyVsix(downloadedPath, id, version);
    if (!check.ok) {
      return {
        confirm:
          `The file offered as ${id} ${version} is published by "${check.manifest.publisher}" ` +
          `(it contains ${check.manifest.id}). Install it anyway?`,
      };
    }
    return {};
  }

  async install(downloadedPath: string, id: string, version: string): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(downloadedPath),
    );
    this.pending.set(id.toLowerCase(), version);
  }
}
