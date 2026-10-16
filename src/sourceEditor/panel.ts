/**
 * The "Leuchtturm Sources" editor tab: a webview with a form per source. VS Code's own
 * Settings UI cannot edit nested objects such as `leuchtturm.sources` (it only offers "Edit in
 * settings.json"), so this form fills that gap. It writes to the user settings only.
 *
 * The page itself is src/sourceEditor/webview/main.ts, bundled to dist/sourceEditor.js.
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { Controller } from '../controller';
import { SECTION } from '../vscodeSettings';
import { discover } from './discover';
import { DOCS_URL } from './formSpec';
import { SourceEditorHost } from './host';
import type { EditorFocus, FromWebview, ToWebview } from './protocol';

export class SourceEditorPanel {
  private static current: SourceEditorPanel | undefined;

  /** Opens the editor (or brings it to the front) and shows `focus`. */
  static show(
    context: vscode.ExtensionContext,
    controller: Controller,
    focus: EditorFocus = { kind: 'list' },
  ): SourceEditorPanel {
    if (SourceEditorPanel.current) {
      SourceEditorPanel.current.panel.reveal();
      void SourceEditorPanel.current.host.refresh(focus);
      return SourceEditorPanel.current;
    }
    SourceEditorPanel.current = new SourceEditorPanel(context, controller, focus);
    return SourceEditorPanel.current;
  }

  /** The open editor, if any (used by the integration tests). */
  static get open(): SourceEditorPanel | undefined {
    return SourceEditorPanel.current;
  }

  readonly panel: vscode.WebviewPanel;
  readonly host: SourceEditorHost;
  private readonly disposables: vscode.Disposable[] = [];
  /** Shown once the page reports it is ready. */
  private pendingFocus: EditorFocus | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    controller: Controller,
    focus: EditorFocus,
  ) {
    this.pendingFocus = focus;
    this.panel = vscode.window.createWebviewPanel(
      'leuchtturm.sourceEditor',
      'Leuchtturm Sources',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Keeps unsaved drafts when the tab is in the background.
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-128.png');
    const config = () => vscode.workspace.getConfiguration(SECTION);
    this.host = new SourceEditorHost({
      // Only the user-level value, like everywhere else (SPEC §9).
      readSources: () => config().inspect<Record<string, unknown>>('sources')?.globalValue ?? {},
      writeSources: async (sources) => {
        await config().update('sources', sources, vscode.ConfigurationTarget.Global);
      },
      confirm: async (message, action) =>
        (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
      test: (name, source) => controller.testDraft(name, source),
      discover: (input) =>
        discover(input, { list: (name, source) => controller.listDraft(name, source) }),
      pickFolder: async () =>
        (
          await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Use This Folder',
            title: 'Folder or share with .vsix files',
          })
        )?.[0]?.fsPath,
      scriptEnabled: () => config().inspect<boolean>('script.enabled')?.globalValue === true,
      open: (what) => {
        if (what === 'scriptSetting') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'leuchtturm.script.enabled',
          );
        } else if (what === 'json') {
          void vscode.commands.executeCommand('workbench.action.openSettingsJson', {
            revealSetting: { key: 'leuchtturm.sources' },
          });
        } else {
          void vscode.env.openExternal(vscode.Uri.parse(`${DOCS_URL}/${what.docs}.md`));
        }
      },
      post: (message: ToWebview) => void this.panel.webview.postMessage(message),
    });

    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: FromWebview) => {
        const focus = message.type === 'ready' ? this.pendingFocus : undefined;
        this.pendingFocus = undefined;
        const work =
          message.type === 'ready'
            ? Promise.resolve(this.host.refresh(focus))
            : this.host.handle(message);
        work.catch((err: unknown) =>
          this.panel.webview.postMessage({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          } satisfies ToWebview),
        );
      }),
      // Edits in settings.json (or another window) show up in the open editor.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          void this.host.refresh();
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...path: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...path));
    // A fresh nonce per page: only our own bundled script may run (Content Security Policy).
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'sourceEditor.css').toString()}">
  <title>Leuchtturm Sources</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${asset('dist', 'sourceEditor.js').toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    SourceEditorPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}
