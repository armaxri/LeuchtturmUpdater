import * as vscode from 'vscode';

import type { Target } from './types';

/** Installs `.vsix` files through VS Code's own (public) install command. */
export class VsCodeExtensionTarget implements Target {
  readonly kind = 'vscode-extension' as const;

  /**
   * Versions installed in this session. `vscode.extensions` keeps reporting the old version
   * until the window reloads, which would make the update show up again right after installing.
   */
  private readonly pending = new Map<string, string>();

  getInstalledVersion(id: string): string | undefined {
    const pending = this.pending.get(id.toLowerCase());
    if (pending) {
      return pending;
    }
    const version: unknown = vscode.extensions.getExtension(id)?.packageJSON?.version;
    return typeof version === 'string' ? version : undefined;
  }

  async install(downloadedPath: string, id: string, version: string): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(downloadedPath),
    );
    this.pending.set(id.toLowerCase(), version);
  }
}
