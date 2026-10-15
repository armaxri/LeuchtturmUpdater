/**
 * Update notifications (SPEC §3.3). They only point the user to the update UI; nothing is ever
 * installed from a notification button.
 *
 * `showInformationMessage` resolves only when the user clicks or dismisses the message, so
 * callers must not await these functions from the check flow.
 */

import * as vscode from 'vscode';

import type { ArtifactState } from '../checker';

export interface NotificationActions {
  showUpdates(ids: string[]): void;
  skip(id: string, version: string): void;
}

export function label(a: Pick<ArtifactState, 'id' | 'displayName'>): string {
  return a.displayName ?? a.id;
}

export async function notifyUpdates(
  updates: readonly ArtifactState[],
  actions: NotificationActions,
): Promise<void> {
  const SHOW = 'Show Updates';
  const SKIP = 'Skip This Version';
  const LATER = 'Later';
  const first = updates[0];
  if (!first?.latest) {
    return;
  }
  if (updates.length === 1) {
    const installed = first.installedVersion ? ` (installed ${first.installedVersion})` : '';
    const choice = await vscode.window.showInformationMessage(
      `Leuchtturm: ${label(first)} ${first.latest.version} is available${installed}.`,
      SHOW,
      SKIP,
      LATER,
    );
    if (choice === SHOW) {
      actions.showUpdates([first.id]);
    } else if (choice === SKIP) {
      actions.skip(first.id, first.latest.version);
    }
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Leuchtturm: ${updates.length} updates available.`,
    SHOW,
    LATER,
  );
  if (choice === SHOW) {
    actions.showUpdates(updates.map((u) => u.id));
  }
}

/** Offers a window reload after installs. One prompt for any number of installed artifacts. */
export async function promptReload(
  installed: readonly { name: string; version: string }[],
): Promise<void> {
  const only = installed[0];
  if (!only) {
    return;
  }
  const message =
    installed.length === 1
      ? `Reload window to activate ${only.name} ${only.version}?`
      : `Reload window to activate ${installed.length} updated extensions?`;
  const choice = await vscode.window.showInformationMessage(message, 'Reload', 'Later');
  if (choice === 'Reload') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
