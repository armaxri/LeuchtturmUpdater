/**
 * Ties config, sources, checker, installer and UI together. Owns the current check state.
 */

import * as vscode from 'vscode';

import {
  artifactLabel as label,
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
import { secretStorageKey, type CachedCheck, type StateStore } from './state';
import type { Target } from './targets/types';
import { notifyUpdates, promptReload } from './ui/notifications';
import { CancelledError, NEVER_CANCELLED, withTimeout } from './util/cancellation';
import { matchesFilters } from './util/glob';
import { compareVersions } from './version';
import { readRawSettings } from './vscodeSettings';

export interface CheckOptions {
  /** A user-started check: always reports its outcome, even with nothing new to announce. */
  manual: boolean;
  /** Only these sources (back-off retries). Default: all. */
  sources?: readonly string[];
}

/** Hooks into UI parts that are created after the controller. */
export interface ControllerUi {
  revealUpdates(ids: readonly string[]): void;
}

export class Controller implements vscode.Disposable {
  private config: Config | undefined;
  private sources = new Map<string, SourceEntry>();
  /** Serialized config per source, to detect which sources a settings edit changed. */
  private fingerprints = new Map<string, string>();
  private lastResults: SourceResult[] = [];
  /** `updatedAt` of the cache entry our `lastResults` came from. */
  private cacheSeen = 0;
  private current: CheckState | undefined;
  private running: Promise<CheckState | undefined> | undefined;
  ui: ControllerUi | undefined;

  private readonly stateEmitter = new vscode.EventEmitter<CheckState>();
  /** Fires whenever the state changes (new check, skip, install, other window). */
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly checkingEmitter = new vscode.EventEmitter<boolean>();
  /** Fires `true` when a check starts and `false` when it ends. */
  readonly onDidChangeChecking = this.checkingEmitter.event;

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

  get isChecking(): boolean {
    return this.running !== undefined;
  }

  /** The config from the last `loadConfig()`. */
  get currentConfig(): Config | undefined {
    return this.config;
  }

  dispose(): void {
    this.stateEmitter.dispose();
    this.checkingEmitter.dispose();
  }

  /**
   * Reads settings and secrets and recreates the sources. Returns the config and the names of
   * sources that were added or changed since the previous load.
   */
  async reloadConfig(): Promise<{ config: Config; changedSources: string[] }> {
    const before = this.fingerprints;
    const config = await this.loadConfig();
    const changedSources = [...this.fingerprints]
      .filter(([n, f]) => before.get(n) !== f)
      .map(([n]) => n);
    return { config, changedSources };
  }

  /** Reads settings and secrets and recreates the sources. */
  async loadConfig(): Promise<Config> {
    const get = readRawSettings();
    const secrets: Record<string, string> = {};
    for (const name of referencedSecrets(get('sources'))) {
      const value = await this.secrets.get(secretStorageKey(name));
      if (value !== undefined) {
        this.log.redactor.add(value);
        secrets[name] = value;
      }
    }
    const config = parseConfig(get, { secrets });
    for (const p of config.problems) {
      this.log.warn(p.message);
    }
    const defaultTimeoutMs = config.settings.httpTimeoutSeconds * 1000;
    for (const c of config.sources) {
      if (c.type === 'http' || c.type === 'npm') {
        c.sensitiveValues.forEach((v) => this.log.redactor.add(v));
      }
    }
    this.sources = new Map(
      config.sources.map((c) => [
        c.name,
        {
          source: createSource(c, this.log, {
            timeoutMs: defaultTimeoutMs,
            addSecret: (v) => this.log.redactor.add(v),
          }),
          timeoutMs: c.timeoutSeconds ? c.timeoutSeconds * 1000 : defaultTimeoutMs,
          include: c.include,
          exclude: c.exclude,
        },
      ]),
    );
    // RegExp objects serialize to `{}`, so write their source text instead.
    this.fingerprints = new Map(
      config.sources.map((c) => [
        c.name,
        JSON.stringify(c, (_k, v: unknown) => (v instanceof RegExp ? v.source : v)),
      ]),
    );
    this.config = config;
    void vscode.commands.executeCommand(
      'setContext',
      'leuchtturm.noSources',
      config.sources.length === 0 && config.problems.every((p) => !p.source),
    );
    return config;
  }

  /** Runs a check. Concurrent calls share the check that is already running. */
  check(options: CheckOptions): Promise<CheckState | undefined> {
    if (!this.running) {
      this.checkingEmitter.fire(true);
      this.running = this.runCheck(options).finally(() => {
        this.running = undefined;
        this.checkingEmitter.fire(false);
      });
    }
    return this.running;
  }

  private async runCheck({ manual, sources }: CheckOptions): Promise<CheckState | undefined> {
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
    const entries = [...this.sources.values()].filter(
      (e) => !sources || sources.includes(e.source.name),
    );
    this.log.info(`Checking ${entries.length} source(s)…`);
    const fresh = await listAll(entries, NEVER_CANCELLED, this.log);
    await this.storeResults(fresh, sources === undefined);
    const state = this.recompute();

    const updates = state.artifacts.filter((a) => a.status === 'update').length;
    this.log.info(
      `Check finished: ${state.artifacts.length} tracked, ${updates} update(s), ` +
        `${state.problems.length} problem(s)`,
    );
    for (const p of state.problems) {
      this.log.warn(p.message);
    }
    this.announce(state, manual);
    return state;
  }

  /** Merges fresh results into ours and the shared cache, tracking failures for back-off. */
  private async storeResults(fresh: SourceResult[], full: boolean): Promise<void> {
    const now = Date.now();
    const previous = this.store.cache;
    const failures = { ...(previous?.failures ?? {}) };
    const byName = new Map(this.lastResults.map((r) => [r.source, r]));
    for (const r of fresh) {
      byName.set(r.source, r);
      if (r.error) {
        failures[r.source] = { count: (failures[r.source]?.count ?? 0) + 1, lastAttempt: now };
      } else {
        delete failures[r.source];
      }
    }
    this.lastResults = [...byName.values()];
    const cache: CachedCheck = {
      checkedAt: full ? now : (previous?.checkedAt ?? now),
      updatedAt: now,
      results: this.lastResults,
      failures,
    };
    this.cacheSeen = now;
    await this.store.setCache(cache);
  }

  /** Loads results another window wrote to the cache, if they are newer than ours. */
  adoptCache(): void {
    const cache = this.store.cache;
    if (!cache || cache.updatedAt <= this.cacheSeen || !this.config || this.running) {
      return;
    }
    this.log.debug(
      `Using results checked by another window at ${new Date(cache.checkedAt).toISOString()}`,
    );
    this.cacheSeen = cache.updatedAt;
    this.lastResults = cache.results;
    this.recompute();
  }

  /** Recomputes the state from the last results (after a skip, an install, a setting change). */
  recompute(): CheckState {
    const config = this.config;
    if (!config) {
      throw new Error('recompute() called before loadConfig()');
    }
    // Settings order breaks ties between sources; drop sources that were removed, and
    // re-apply filters in case include/exclude changed since the results were cached.
    const results = config.sources.flatMap((c) => {
      const r = this.lastResults.find((x) => x.source === c.name);
      return r
        ? [
            {
              ...r,
              artifacts: r.artifacts.filter((a) => matchesFilters(a.id, c.include, c.exclude)),
            },
          ]
        : [];
    });
    const state = computeState({
      results,
      tracking: config.tracking,
      trackAllFromSources: config.settings.trackAllFromSources,
      includePrerelease: config.settings.includePrerelease,
      installedVersion: (id) => this.target.getInstalledVersion(id),
      displayName: (id) => this.target.getDisplayName?.(id),
      isSkipped: (id, version) => this.store.isSkipped(id, version),
      configProblems: config.problems,
      now: this.store.cache?.checkedAt,
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
      showUpdates: (ids) => this.ui?.revealUpdates(ids),
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

  findArtifact(id: string): ArtifactState | undefined {
    return this.current?.artifacts.find((a) => a.id.toLowerCase() === id.toLowerCase());
  }

  /** Quick pick of available updates; installs what the user confirms. */
  async pickAndUpdate(preselect?: readonly string[]): Promise<number> {
    const state = await this.ensureState();
    const updatable = (state?.artifacts ?? []).filter(
      (a) => a.status === 'update' || a.status === 'skipped',
    );
    if (updatable.length === 0) {
      void vscode.window.showInformationMessage('Leuchtturm: no updates available.');
      return 0;
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
    if (!picked || picked.length === 0) {
      return 0;
    }
    return this.installCandidates(picked.map((p) => p.artifact.latest!));
  }

  /** Installs every available update (skipped versions excluded). */
  async updateAll(): Promise<number> {
    const state = await this.ensureState();
    const updates = (state?.artifacts ?? []).filter((a) => a.status === 'update');
    if (updates.length === 0) {
      void vscode.window.showInformationMessage('Leuchtturm: no updates available.');
      return 0;
    }
    return this.installCandidates(updates.map((a) => a.latest!));
  }

  /**
   * Installs a specific version. With `id`/`version` arguments (from the tree, a keybinding
   * or a test) the quick picks are skipped. Downgrades always need a modal confirmation.
   */
  async installVersion(id?: string, version?: string): Promise<number> {
    const state = await this.ensureState();
    const artifacts = state?.artifacts ?? [];
    let artifact: ArtifactState | undefined;
    if (id) {
      artifact = this.findArtifact(id);
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

  /**
   * Shows release notes as a Markdown preview: inline text, or text fetched by the source
   * (with its credentials). Falls back to opening the notes URL in the browser.
   */
  async showReleaseNotes(candidate: Candidate): Promise<void> {
    const { releaseNotesUrl } = candidate.available;
    let releaseNotes = candidate.available.releaseNotes;
    const name = label(this.findArtifact(candidate.artifact.id) ?? candidate.artifact);
    const source = this.sources.get(candidate.sourceName)?.source;
    if (!releaseNotes && releaseNotesUrl && source?.fetchReleaseNotes) {
      try {
        releaseNotes = await source.fetchReleaseNotes(
          candidate.artifact,
          candidate.available,
          NEVER_CANCELLED,
        );
      } catch (err) {
        this.log.warn(`Release notes from ${releaseNotesUrl}: ${errorMessage(err)}`);
      }
    }
    if (releaseNotes) {
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: `# ${name} ${candidate.version}\n\n${releaseNotes}`,
      });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    } else if (releaseNotesUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(releaseNotesUrl));
    } else {
      void vscode.window.showInformationMessage(
        `Leuchtturm: no release notes for ${name} ${candidate.version}.`,
      );
    }
  }

  /**
   * Stores a credential for `${secret:NAME}` in VS Code's SecretStorage (encrypted by the OS
   * keychain). Arguments skip the prompts (tests). An empty value deletes the secret.
   */
  async setSecret(name?: string, value?: string): Promise<boolean> {
    if (!name) {
      const referenced = referencedSecrets(readRawSettings()('sources'));
      const items = await Promise.all(
        referenced.map(async (n) => ({
          label: n,
          description: (await this.secrets.get(secretStorageKey(n))) ? 'stored' : 'not stored',
        })),
      );
      const OTHER = 'Another name…';
      const picked = await vscode.window.showQuickPick(
        [...items, { label: OTHER, description: '' }],
        {
          title: 'Leuchtturm: Store Credential',
          placeHolder: 'Which ${secret:NAME} do you want to set?',
        },
      );
      name =
        picked?.label === OTHER
          ? await vscode.window.showInputBox({
              title: 'Leuchtturm: Store Credential',
              prompt: 'Name used as ${secret:NAME} in leuchtturm.sources',
              validateInput: (v) =>
                /^[\w.-]+$/.test(v) ? undefined : 'Letters, digits, _ . - only',
            })
          : picked?.label;
      if (!name) {
        return false;
      }
    }
    if (value === undefined) {
      value = await vscode.window.showInputBox({
        title: `Leuchtturm: Store Credential "${name}"`,
        prompt: "Stored encrypted in VS Code's secret storage. Leave empty to delete it.",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return false;
      }
    }
    if (value === '') {
      await this.secrets.delete(secretStorageKey(name));
      this.log.info(`Deleted secret "${name}"`);
    } else {
      this.log.redactor.add(value);
      await this.secrets.store(secretStorageKey(name), value);
      this.log.info(`Stored secret "${name}"`);
    }
    await this.check({ manual: false });
    return true;
  }

  /**
   * Runs one source and prints everything it saw to the log: matched and skipped files,
   * filters, resulting artifacts and download references. Returns the report text.
   */
  async testSource(name?: string): Promise<string | undefined> {
    const config = await this.loadConfig();
    const invalid = config.problems.filter((p) => p.source);
    if (!name) {
      const picked = await vscode.window.showQuickPick(
        [
          ...config.sources.map((s) => ({ label: s.name, description: s.type })),
          ...invalid.map((p) => ({ label: p.source!, description: 'invalid configuration' })),
        ],
        { title: 'Leuchtturm: Test Source', placeHolder: 'Select a source to test' },
      );
      name = picked?.label;
      if (!name) {
        return undefined;
      }
    }

    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    out(`===== Test source "${name}" =====`);
    const entry = this.sources.get(name);
    const problem = invalid.find((p) => p.source === name);
    if (!entry) {
      out(problem ? problem.message : `No enabled source named "${name}".`);
    } else {
      const { source, timeoutMs, include, exclude } = entry;
      out(`Type: ${source.type}, timeout: ${timeoutMs / 1000} s`);
      for (const w of source.warnings ?? []) {
        out(`WARNING: ${w}`);
      }
      if (include.length || exclude.length) {
        out(`Filters: include ${JSON.stringify(include)}, exclude ${JSON.stringify(exclude)}`);
      }
      const start = Date.now();
      try {
        const artifacts = await withTimeout(
          timeoutMs,
          NEVER_CANCELLED,
          (t) => source.list(t, out),
          `Source "${name}"`,
        );
        out(`Listed in ${Date.now() - start} ms. Result:`);
        for (const a of artifacts) {
          const filtered = !matchesFilters(a.id, include, exclude);
          out(
            `- ${a.id}${a.displayName ? ` (${a.displayName})` : ''}${filtered ? '  [removed by filters]' : ''}`,
          );
          for (const v of a.versions) {
            const extras = [
              v.sha256 ? `sha256 ${v.sha256.slice(0, 12)}…` : undefined,
              v.releaseNotes ? 'release notes' : undefined,
              v.releaseNotesUrl ? `notes ${v.releaseNotesUrl}` : undefined,
            ].filter(Boolean);
            out(`    ${v.version}${extras.length ? `  (${extras.join(', ')})` : ''}`);
            for (const [k, val] of Object.entries(v.ref)) {
              out(`      ${k}: ${val}`);
            }
          }
        }
        if (artifacts.length === 0) {
          out('Nothing found.');
        }
      } catch (err) {
        out(`FAILED after ${Date.now() - start} ms: ${errorMessage(err)}`);
      }
    }
    const text = lines.join('\n');
    this.log.info(text);
    this.log.show();
    return this.log.redactor.redact(text);
  }
}
