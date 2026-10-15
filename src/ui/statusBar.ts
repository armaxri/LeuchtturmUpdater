/** Status bar item (SPEC §3.2): `$(broadcast) 2` with updates, a spinner while checking. */

import * as vscode from 'vscode';

import { statusBarView, type StatusBarInput, type StatusBarView } from './statusBarModel';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'leuchtturm.status',
    vscode.StatusBarAlignment.Left,
    10,
  );

  constructor() {
    this.item.name = 'Leuchtturm Updater';
    this.item.command = 'leuchtturm.updates.focus';
  }

  update(input: StatusBarInput): StatusBarView {
    const view = statusBarView(input);
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    // A dimmed look with no updates, so "always" mode does not draw attention.
    this.item.color =
      input.updates > 0 || input.checking ? undefined : new vscode.ThemeColor('disabledForeground');
    if (view.visible) {
      this.item.show();
    } else {
      this.item.hide();
    }
    return view;
  }

  dispose(): void {
    this.item.dispose();
  }
}
