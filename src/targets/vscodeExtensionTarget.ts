import * as vscode from 'vscode';

import { verifyVsix } from '../util/vsix';
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

  getDisplayName(id: string): string | undefined {
    const name: unknown = vscode.extensions.getExtension(id)?.packageJSON?.displayName;
    // Localized manifests use placeholders like `%displayName%`; those are no use here.
    return typeof name === 'string' && !name.startsWith('%') ? name : undefined;
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
