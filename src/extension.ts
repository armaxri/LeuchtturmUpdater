/**
 * Entry point. VS Code calls `activate` once per window (see `activationEvents` in
 * package.json) and `deactivate` on shutdown. Everything pushed to `context.subscriptions`
 * is disposed automatically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { CheckState } from './checker';
import { Controller } from './controller';
import { HELPER_VSIX } from './helper/protocol';
import { SourceEditorPanel } from './sourceEditor/panel';
import { Installer } from './installer';
import { errorMessage, RedactingLogger } from './log';
import { canLead, Scheduler } from './scheduler';
import { StateStore } from './state';
import { VsCodeExtensionTarget } from './targets/vscodeExtensionTarget';
import { StatusBar } from './ui/statusBar';
import type { StatusBarView } from './ui/statusBarModel';
import { updateCount, type Node } from './ui/treeModel';
import { LeuchtturmTreeProvider } from './ui/treeView';
import type { JsonSchema } from './util/jsonSchema';
import { Redactor } from './util/redact';
import { SECTION } from './vscodeSettings';

/**
 * Returned from `activate` for the integration tests.
 * @internal Unstable and not a supported API: other extensions must not depend on it.
 */
export interface LeuchtturmApi {
  checkNow(): Promise<CheckState | undefined>;
  readonly state: CheckState | undefined;
  readonly treeModel: readonly Node[];
  readonly badge: number | undefined;
  readonly statusBar: StatusBarView | undefined;
  readonly scheduler: Scheduler;
}

/** Install leases expire after this, in case a window dies mid-install. */
const INSTALL_LEASE_MS = 10 * 60_000;

export async function activate(context: vscode.ExtensionContext): Promise<LeuchtturmApi> {
  const channel = vscode.window.createOutputChannel('Leuchtturm Updater', { log: true });
  const log = new RedactingLogger(channel, new Redactor());
  const windowId = vscode.env.sessionId;
  const target = new VsCodeExtensionTarget({
    vsixPath: path.join(context.extensionPath, 'dist', HELPER_VSIX),
    version: String(context.extension.packageJSON.version),
  });
  const store = new StateStore(context.globalState);
  const installer = new Installer(
    path.join(context.globalStorageUri.fsPath, 'downloads'),
    target,
    log,
    {
      acquire: (id) => store.acquireInstall(id, windowId, Date.now(), INSTALL_LEASE_MS),
      release: (id) => store.releaseInstall(id, windowId),
    },
    async (question) =>
      (await vscode.window.showWarningMessage(question, { modal: true }, 'Install Anyway')) ===
      'Install Anyway',
  );
  // Shipped with the extension (schemas/), so scripts and Leuchtturm validate against one file.
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(context.extensionPath, 'schemas', 'script-protocol.schema.json'),
      'utf8',
    ),
  ) as JsonSchema;
  const controller = new Controller(context.secrets, log, target, store, installer, {
    schema,
    hostVersion: vscode.version,
  });

  // --- UI -------------------------------------------------------------------------------
  const tree = new LeuchtturmTreeProvider();
  const treeView = vscode.window.createTreeView<Node>('leuchtturm.updates', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = new StatusBar();
  let statusBarView: StatusBarView | undefined;

  const refreshUi = (): void => {
    const state = controller.state;
    tree.update(state);
    const updates = updateCount(state);
    treeView.badge =
      updates > 0
        ? { value: updates, tooltip: `${updates} update${updates === 1 ? '' : 's'} available` }
        : undefined;
    const settings = controller.currentConfig?.settings;
    statusBarView = statusBar.update({
      mode: settings?.statusBar ?? 'whenUpdates',
      enabled: settings?.enabled ?? true,
      checking: controller.isChecking,
      updates,
      problems: state?.problems.length ?? 0,
    });
  };

  controller.ui = {
    revealUpdates: (ids) => {
      void (async () => {
        await vscode.commands.executeCommand('leuchtturm.updates.focus');
        const nodes = tree.findArtifacts(ids);
        for (const [i, node] of nodes.entries()) {
          await treeView.reveal(node, { select: i === 0, focus: i === 0, expand: false });
        }
      })();
    },
  };

  // --- Scheduling -----------------------------------------------------------------------
  const checkInBackground = async (sources?: readonly string[]): Promise<void> => {
    await controller.check({ manual: false, sources });
  };
  const scheduler = new Scheduler(
    {
      settings: () => controller.currentConfig!.settings,
      sourceNames: () => controller.currentConfig?.sources.map((s) => s.name) ?? [],
      check: (plan) => checkInBackground(plan === 'all' ? undefined : plan),
      adoptCache: () => controller.adoptCache(),
    },
    store,
    windowId,
    log,
  );

  // Settings edits arrive in every window. Recompute right away; only the window leading
  // the checks re-lists added or changed sources, the others pick up its cached results.
  let configTimer: ReturnType<typeof setTimeout> | undefined;
  const onConfigChanged = async (): Promise<void> => {
    const { config, changedSources } = await controller.reloadConfig();
    controller.recompute();
    if (
      config.settings.enabled &&
      changedSources.length > 0 &&
      canLead(store.checkLease, windowId, Date.now())
    ) {
      await checkInBackground(changedSources);
    }
  };

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
    tree,
    treeView,
    statusBar,
    controller.onDidChangeState(refreshUi),
    controller.onDidChangeChecking(refreshUi),
    command('leuchtturm.checkNow', () => controller.check({ manual: true })),
    command('leuchtturm.updateAll', () => controller.updateAll()),
    command('leuchtturm.update', () => controller.pickAndUpdate()),
    command('leuchtturm.installVersion', (id?: string, version?: string) =>
      controller.installVersion(id, version),
    ),
    command('leuchtturm.clearSkipped', () => controller.clearSkipped()),
    command('leuchtturm.showLog', () => channel.show()),
    command('leuchtturm.testSource', (name?: string) => controller.testSource(name)),
    command('leuchtturm.setSecret', (name?: string, value?: string) =>
      controller.setSecret(name, value),
    ),
    command('leuchtturm.approveScript', (name?: string, confirmed?: boolean) =>
      controller.approveScript(name, confirmed === true),
    ),
    command('leuchtturm.installRemoteHelper', async () => {
      if (!vscode.env.remoteName) {
        void vscode.window.showInformationMessage(
          'Leuchtturm: the helper is only needed in remote windows (Dev Containers, SSH, WSL).',
        );
        return;
      }
      log.info(`Installing the remote helper (${vscode.env.remoteName})`);
      const ok = await target.installHelper();
      controller.recompute();
      if (ok) {
        log.info('Remote helper is ready');
      } else {
        log.warn('Remote helper was installed but does not answer yet');
        void vscode.window.showWarningMessage(
          'Leuchtturm: the helper was installed but does not answer yet. Reload the window if ' +
            'extensions on the remote side stay invisible.',
        );
      }
    }),
    // The source editor: VS Code's Settings UI cannot edit nested objects like our sources.
    command('leuchtturm.manageSources', () => {
      SourceEditorPanel.show(context, controller);
    }),
    command('leuchtturm.addSource', () => {
      SourceEditorPanel.show(context, controller, { kind: 'new' });
    }),
    // From the tree (a problem or artifact node), a link, or a test with a source name.
    command('leuchtturm.editSource', (arg?: Node | string) => {
      const name =
        typeof arg === 'string'
          ? arg
          : arg?.type === 'problem'
            ? arg.problem.source
            : arg?.type === 'artifact'
              ? (arg.artifact.latest ?? arg.artifact.candidates[0])?.sourceName
              : undefined;
      SourceEditorPanel.show(
        context,
        controller,
        name ? { kind: 'source', name } : { kind: 'list' },
      );
    }),
    command('leuchtturm.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`,
      ),
    ),
    // Tree item actions. They receive the clicked node and are hidden from the palette.
    command('leuchtturm.tree.update', (node: Node) =>
      node.type === 'artifact' && node.artifact.latest
        ? controller.installCandidates([node.artifact.latest])
        : 0,
    ),
    command('leuchtturm.tree.installVersion', (node: Node) =>
      node.type === 'version'
        ? controller.installVersion(node.artifact.id, node.candidate.version)
        : 0,
    ),
    command('leuchtturm.tree.skip', (node: Node) =>
      node.type === 'artifact' && node.artifact.latest
        ? controller.skip(node.artifact.id, node.artifact.latest.version)
        : undefined,
    ),
    command('leuchtturm.tree.releaseNotes', (node: Node) => {
      const candidate =
        node.type === 'version'
          ? node.candidate
          : node.type === 'artifact'
            ? node.artifact.latest
            : undefined;
      return candidate && controller.showReleaseNotes(candidate);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        // Debounced: the settings editor fires once per keystroke.
        clearTimeout(configTimer);
        configTimer = setTimeout(
          () => void onConfigChanged().catch((err: unknown) => log.error(errorMessage(err))),
          500,
        );
      }
    }),
    // Installs and uninstalls through the Extensions view change installed versions.
    vscode.extensions.onDidChange(() => {
      if (controller.currentConfig) {
        controller.recompute();
      }
    }),
    { dispose: () => clearTimeout(configTimer) },
  );

  log.info(`Leuchtturm Updater ${String(context.extension.packageJSON.version)} activated`);
  await controller.loadConfig();
  // Show the last known results right away (possibly checked by another window).
  controller.adoptCache();
  refreshUi();
  scheduler.start();
  if (vscode.env.remoteName) {
    // Versions on the remote side come from the helper; fetch them without waiting for a check.
    void target.refresh().then(() => controller.currentConfig && controller.recompute());
  }

  return {
    checkNow: () => controller.check({ manual: false }),
    get state() {
      return controller.state;
    },
    get treeModel() {
      return tree.model;
    },
    get badge() {
      return treeView.badge?.value;
    },
    get statusBar() {
      return statusBarView;
    },
    scheduler,
  };
}

export function deactivate(): void {
  // Nothing to do: all resources are registered in context.subscriptions.
}
