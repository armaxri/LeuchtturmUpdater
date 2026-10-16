/**
 * Leuchtturm Remote Helper: a tiny extension that runs on the remote side of a remote window
 * (`extensionKind: ["workspace"]`) and tells Leuchtturm which extensions are installed there.
 * It is bundled on its own (see esbuild.mjs) and shipped inside Leuchtturm's .vsix; Leuchtturm
 * installs it when the user clicks "Install Helper" in a remote window. See ./protocol.ts.
 */

import * as vscode from 'vscode';

import { HELPER_COMMAND, HELPER_PROTOCOL, type HelperResponse } from './protocol';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(HELPER_COMMAND, (): HelperResponse => {
      const manifest = (e: vscode.Extension<unknown>) =>
        e.packageJSON as { version?: unknown; displayName?: unknown };
      return {
        protocol: HELPER_PROTOCOL,
        helperVersion: String(manifest(context.extension).version),
        // Only this extension host's extensions: exactly the ones Leuchtturm cannot see.
        extensions: vscode.extensions.all.flatMap((e) => {
          const { version, displayName } = manifest(e);
          return typeof version === 'string'
            ? [
                {
                  id: e.id,
                  version,
                  ...(typeof displayName === 'string' && !displayName.startsWith('%')
                    ? { displayName }
                    : {}),
                },
              ]
            : [];
        }),
      };
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}
