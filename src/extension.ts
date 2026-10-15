/**
 * Entry point. VS Code calls `activate` once per window (see `activationEvents` in
 * package.json) and `deactivate` on shutdown. Everything pushed to `context.subscriptions`
 * is disposed automatically.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

import type { CheckState } from './checker';
import { parseSettings } from './config';
import { Controller } from './controller';
import { Installer } from './installer';
import { errorMessage, RedactingLogger } from './log';
import { Scheduler } from './scheduler';
import { StateStore } from './state';
import { VsCodeExtensionTarget } from './targets/vscodeExtensionTarget';
import { Redactor } from './util/redact';
import { readRawSettings, SECTION } from './vscodeSettings';

/**
 * Returned from `activate` for the integration tests.
 * @internal Unstable and not a supported API: other extensions must not depend on it.
 */
export interface LeuchtturmApi {
  checkNow(): Promise<CheckState | undefined>;
  readonly state: CheckState | undefined;
}

export function activate(context: vscode.ExtensionContext): LeuchtturmApi {
  const channel = vscode.window.createOutputChannel('Leuchtturm Updater', { log: true });
  const log = new RedactingLogger(channel, new Redactor());
  const target = new VsCodeExtensionTarget();
  const store = new StateStore(context.globalState);
  const installer = new Installer(
    path.join(context.globalStorageUri.fsPath, 'downloads'),
    target,
    log,
  );
  const controller = new Controller(context.secrets, log, target, store, installer);

  const checkInBackground = (): void => {
    controller.check({ manual: false }).catch((err: unknown) => log.error(errorMessage(err)));
  };
  const scheduler = new Scheduler(checkInBackground);
  scheduler.start(parseSettings(readRawSettings()), true);

  // Wraps a command handler so that unexpected errors end up in the log and a message.
  const command = (id: string, handler: (...args: never[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        return await handler(...args);
      } catch (err) {
        log.error(`${id}: ${errorMessage(err)}`);
        void vscode.window.showErrorMessage(`Leuchtturm: ${errorMessage(err)}`);
        return undefined;
      }
    });

  context.subscriptions.push(
    channel,
    controller,
    scheduler,
    command('leuchtturm.checkNow', () => controller.check({ manual: true })),
    command('leuchtturm.update', () => controller.pickAndUpdate()),
    command('leuchtturm.installVersion', (id?: string, version?: string) =>
      controller.installVersion(id, version),
    ),
    command('leuchtturm.clearSkipped', () => controller.clearSkipped()),
    command('leuchtturm.showLog', () => channel.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        scheduler.reschedule(parseSettings(readRawSettings()));
      }
    }),
  );

  log.info(`Leuchtturm Updater ${String(context.extension.packageJSON.version)} activated`);

  return {
    checkNow: () => controller.check({ manual: false }),
    get state() {
      return controller.state;
    },
  };
}

export function deactivate(): void {
  // Nothing to do: all resources are registered in context.subscriptions.
}
