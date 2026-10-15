/**
 * Ties config, sources, checker, installer and UI together. Owns the current check state.
 */

import * as vscode from 'vscode';

import {
  computeState,
  listAll,
  type ArtifactState,
  type Candidate,
  type CheckState,
  type SourceEntry,
  type SourceResult,
} from './checker';
import { parseConfig, referencedSecrets, type Config } from './config';
import type { Installer } from './installer';
import { errorMessage, type RedactingLogger } from './log';
import { createSource } from './sources';
import type { StateStore } from './state';
import type { Target } from './targets/types';
import { label, notifyUpdates, promptReload } from './ui/notifications';
import { CancelledError, NEVER_CANCELLED } from './util/cancellation';
import { compareVersions } from './version';
import { readRawSettings } from './vscodeSettings';

export interface CheckOptions {
  /** A user-started check: always reports its outcome, even with nothing new to announce. */
  manual: boolean;
}

export class Controller implements vscode.Disposable {
  private config: Config | undefined;
  private sources = new Map<string, SourceEntry>();
  private lastResults: SourceResult[] = [];
  private current: CheckState | undefined;
  private running: Promise<CheckState | undefined> | undefined;

  private readonly stateEmitter = new vscode.EventEmitter<CheckState>();
  /** Fires whenever the state changes (new check, skip, install). */
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: RedactingLogger,
    private readonly target: Target,
    private readonly store: StateStore,
    private readonly installer: Installer,
  ) {}

  get state(): CheckState | undefined {
    return this.current;
  }

  dispose(): void {
    this.stateEmitter.dispose();
  }

  /** Reads settings and secrets and recreates the sources. */
  async loadConfig(): Promise<Config> {
    const get = readRawSettings();
    const secrets: Record<string, string> = {};
    for (const name of referencedSecrets(get('sources'))) {
      const value = await this.secrets.get(name);
      if (value !== undefined) {
        this.log.redactor.add(value);
        secrets[name] = value;
      }
    }
    const config = parseConfig(get, { secrets });
    for (const p of config.problems) {
      this.log.warn(p.message);
    }
    const defaultTimeout = config.settings.httpTimeoutSeconds;
    this.sources = new Map(
      config.sources.map((c) => [
        c.name,
        {
          source: createSource(c, this.log),
          timeoutMs: (c.timeoutSeconds ?? defaultTimeout) * 1000,
          include: c.include,
          exclude: c.exclude,
        },
      ]),
    );
    this.config = config;
    return config;
  }

  /** Runs a check. Concurrent calls share the check that is already running. */
  check(options: CheckOptions): Promise<CheckState | undefined> {
    this.running ??= this.runCheck(options).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runCheck({ manual }: CheckOptions): Promise<CheckState | undefined> {
    // Re-read the config every time: cheap, and picks up edited settings and new secrets.
    const config = await this.loadConfig();
    if (!config.settings.enabled) {
      this.log.info('Leuchtturm is disabled (leuchtturm.enabled = false); skipping check');
      if (manual) {
        void vscode.window.showInformationMessage(
          'Leuchtturm is disabled. Enable "leuchtturm.enabled" to check for updates.',
        );
      }
      return undefined;
    }
    this.log.info(`Checking ${this.sources.size} source(s)…`);
    this.lastResults = await listAll([...this.sources.values()], NEVER_CANCELLED, this.log);
    const state = this.recompute();
    await this.store.setLastCheck(state.checkedAt);

    const counts = new Map<string, number>();
    for (const a of state.artifacts) {
      counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    }
    this.log.info(
      `Check finished: ${state.artifacts.length} tracked, ` +
        `${counts.get('update') ?? 0} update(s), ${state.problems.length} problem(s)`,
    );
    for (const p of state.problems) {
      this.log.warn(p.message);
    }
    this.announce(state, manual);
    return state;
  }

  /** Recomputes the state from the last source results (after a skip or an install). */
  private recompute(): CheckState {
    const config = this.config;
    if (!config) {
      throw new Error('recompute() called before loadConfig()');
    }
    const state = computeState({
      results: this.lastResults,
      tracking: config.tracking,
      trackAllFromSources: config.settings.trackAllFromSources,
      includePrerelease: config.settings.includePrerelease,
      installedVersion: (id) => this.target.getInstalledVersion(id),
      isSkipped: (id, version) => this.store.isSkipped(id, version),
      configProblems: config.problems,
    });
    this.current = state;
    this.stateEmitter.fire(state);
    return state;
  }

  private announce(state: CheckState, manual: boolean): void {
    const updates = state.artifacts.filter((a) => a.status === 'update');
    // Announce each (id, version) once, so periodic checks don't nag. A manual check
    // always reports everything it found.
    const fresh = manual
      ? updates
      : updates.filter((a) => a.latest && !this.store.isAnnounced(a.id, a.latest.version));

    if (manual && updates.length === 0) {
      if (state.problems.length > 0) {
        void vscode.window
          .showWarningMessage(
            `Leuchtturm: check finished with ${state.problems.length} problem(s).`,
            'Show Log',
          )
          .then((c) => c && this.log.show());
      } else {
        void vscode.window.showInformationMessage(
          `Leuchtturm: all ${state.artifacts.length} tracked extension(s) are up to date.`,
        );
      }
      return;
    }
    if (fresh.length === 0 || (!manual && !this.config?.settings.notify)) {
      return;
    }
    void this.store.markAnnounced(fresh.map((a) => ({ id: a.id, version: a.latest!.version })));
    // Not awaited: the promise only resolves when the user reacts to the message.
    void notifyUpdates(fresh, {
      showUpdates: (ids) => void this.pickAndUpdate(ids),
      skip: (id, version) => void this.skip(id, version),
    });
  }

  async skip(id: string, version: string): Promise<void> {
    await this.store.skip(id, version);
    this.log.info(`Skipping ${id}@${version}`);
    if (this.config) {
      this.recompute();
    }
  }

  async clearSkipped(): Promise<void> {
    await this.store.clearSkipped();
    this.log.info('Cleared skipped versions');
    if (this.config) {
      this.recompute();
    }
  }

  private async ensureState(): Promise<CheckState | undefined> {
    return this.current ?? (await this.check({ manual: false }));
  }

  /** Quick pick of available updates; installs what the user confirms. */
  async pickAndUpdate(preselect?: readonly string[]): Promise<void> {
    const state = await this.ensureState();
    const updatable = (state?.artifacts ?? []).filter(
      (a) => a.status === 'update' || a.status === 'skipped',
    );
    if (updatable.length === 0) {
      void vscode.window.showInformationMessage('Leuchtturm: no updates available.');
      return;
    }
    const wanted = preselect && new Set(preselect.map((id) => id.toLowerCase()));
    const items = updatable.map((a) => ({
      label: label(a),
      description: `${a.installedVersion ?? '?'} → ${a.latest!.version}${a.status === 'skipped' ? ' (skipped)' : ''}`,
      detail: `${a.id} · from ${a.latest!.sourceName}`,
      picked: wanted ? wanted.has(a.id.toLowerCase()) : a.status === 'update',
      artifact: a,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Leuchtturm: Update Extensions',
      placeHolder: 'Select the extensions to update',
      canPickMany: true,
    });
    if (picked && picked.length > 0) {
      await this.installCandidates(picked.map((p) => p.artifact.latest!));
    }
  }

  /**
   * Installs a specific version. With `id`/`version` arguments (e.g. from a keybinding or a
   * test) the quick picks are skipped. Downgrades always need a modal confirmation.
   */
  async installVersion(id?: string, version?: string): Promise<number> {
    const state = await this.ensureState();
    const artifacts = state?.artifacts ?? [];
    let artifact: ArtifactState | undefined;
    if (id) {
      artifact = artifacts.find((a) => a.id.toLowerCase() === id.toLowerCase());
      if (!artifact) {
        void vscode.window.showErrorMessage(`Leuchtturm: ${id} is not offered by any source.`);
        return 0;
      }
    } else {
      if (artifacts.length === 0) {
        void vscode.window.showInformationMessage('Leuchtturm: no extensions are available.');
        return 0;
      }
      artifact = (
        await vscode.window.showQuickPick(
          artifacts.map((a) => ({
            label: label(a),
            description: a.installedVersion ? `installed ${a.installedVersion}` : 'not installed',
            detail: a.id,
            artifact: a,
          })),
          { title: 'Leuchtturm: Install Specific Version', placeHolder: 'Select an extension' },
        )
      )?.artifact;
    }
    if (!artifact) {
      return 0;
    }

    let candidate: Candidate | undefined;
    if (version) {
      candidate = artifact.candidates.find((c) => c.version === version);
      if (!candidate) {
        void vscode.window.showErrorMessage(
          `Leuchtturm: ${artifact.id} ${version} is not available.`,
        );
        return 0;
      }
    } else {
      candidate = (
        await vscode.window.showQuickPick(
          artifact.candidates.map((c) => ({
            label: c.version,
            description:
              (c.version === artifact.installedVersion ? 'installed · ' : '') + c.sourceName,
            candidate: c,
          })),
          { title: `Leuchtturm: Install ${label(artifact)}`, placeHolder: 'Select a version' },
        )
      )?.candidate;
    }
    if (!candidate) {
      return 0;
    }

    const installed = artifact.installedVersion;
    if (installed && compareVersions(candidate.version, installed) < 0) {
      const ok = await vscode.window.showWarningMessage(
        `Downgrade ${label(artifact)} from ${installed} to ${candidate.version}?`,
        { modal: true },
        'Downgrade',
      );
      if (ok !== 'Downgrade') {
        return 0;
      }
    }
    return this.installCandidates([candidate]);
  }

  /** Installs one by one with progress, then shows a single reload prompt. */
  async installCandidates(candidates: readonly Candidate[]): Promise<number> {
    const done: { name: string; version: string }[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Leuchtturm',
        cancellable: true,
      },
      async (progress, token) => {
        for (const [i, c] of candidates.entries()) {
          if (token.isCancellationRequested) {
            break;
          }
          const name = c.artifact.displayName ?? c.artifact.id;
          progress.report({
            message: `Installing ${name} ${c.version} (${i + 1}/${candidates.length})`,
            increment: i === 0 ? 0 : 100 / candidates.length,
          });
          const entry = this.sources.get(c.sourceName);
          try {
            if (!entry) {
              throw new Error(`source "${c.sourceName}" is no longer configured`);
            }
            await this.installer.install(entry.source, c, token);
            done.push({ name, version: c.version });
          } catch (err) {
            if (err instanceof CancelledError) {
              break;
            }
            this.log.error(`Installing ${c.artifact.id}@${c.version} failed: ${errorMessage(err)}`);
            void vscode.window
              .showErrorMessage(
                `Leuchtturm: installing ${name} ${c.version} failed: ${errorMessage(err)}`,
                'Show Log',
              )
              .then((choice) => choice && this.log.show());
          }
        }
      },
    );
    if (this.config) {
      this.recompute();
    }
    // Not awaited: resolves only when the user answers.
    void promptReload(done);
    return done.length;
  }
}
