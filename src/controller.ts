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
import { parseConfig, parseSettings, type Config, type SourceConfig } from './config';
import type { Installer } from './installer';
import { errorMessage, type RedactingLogger } from './log';
import { createSource } from './sources';
import { ScriptSource, type ScriptGate } from './sources/scriptSource';
import type { Artifact } from './sources/types';
import type { JsonSchema } from './util/jsonSchema';
import type { CachedCheck, StateStore } from './state';
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

  /** Script approvals already requested in this session (one prompt per fingerprint). */
  private readonly approvalPrompts = new Set<string>();

  constructor(
    private readonly log: RedactingLogger,
    private readonly target: Target,
    private readonly store: StateStore,
    private readonly installer: Installer,
    private readonly scriptInfo: { schema: JsonSchema; hostVersion: string },
  ) {}

  /** Decides whether script sources may run. Re-read from the settings on every spawn. */
  private readonly scriptGate: ScriptGate = {
    enabled: () => parseSettings(readRawSettings()).scriptEnabled,
    isApproved: (fingerprint) => this.store.isScriptApproved(fingerprint),
    requestApproval: (sourceName, fingerprint, commandLine) => {
      if (this.approvalPrompts.has(fingerprint)) {
        return;
      }
      this.approvalPrompts.add(fingerprint);
      void vscode.window
        .showWarningMessage(
          `Leuchtturm: source "${sourceName}" wants to run "${commandLine}". Allow it only if you trust this program.`,
          'Review and Allow…',
        )
        .then((choice) => choice && this.approveScript(sourceName));
    },
  };

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
   * Reads the settings and recreates the sources. Returns the config and the names of
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

  /** Reads the settings and recreates the sources. */
  async loadConfig(): Promise<Config> {
    const get = readRawSettings();
    const config = parseConfig(get);
    for (const p of config.problems) {
      this.log.warn(p.message);
    }
    this.sources = new Map(config.sources.map((c) => [c.name, this.createEntry(c, config)]));
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

  private createEntry(c: SourceConfig, config: Config): SourceEntry {
    const defaultTimeoutMs =
      (c.type === 'script'
        ? config.settings.scriptTimeoutSeconds
        : config.settings.httpTimeoutSeconds) * 1000;
    return {
      source: createSource(c, this.log, {
        timeoutMs: defaultTimeoutMs,
        script: { gate: this.scriptGate, ...this.scriptInfo },
      }),
      timeoutMs: c.timeoutSeconds ? c.timeoutSeconds * 1000 : defaultTimeoutMs,
      include: c.include,
      exclude: c.exclude,
    };
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
    // Re-read the config every time: cheap, and picks up edited settings.
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
    const [fresh] = await Promise.all([
      listAll(entries, NEVER_CANCELLED, this.log),
      // In a remote window: ask the remote helper what is installed there.
      this.target.refresh?.(),
    ]);
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
      configProblems: [...config.problems, ...(this.target.problems?.() ?? [])],
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
    const canFetch = releaseNotesUrl || candidate.available.releaseNotesOnDemand;
    if (!releaseNotes && canFetch && source?.fetchReleaseNotes) {
      try {
        releaseNotes = await source.fetchReleaseNotes(
          candidate.artifact,
          candidate.available,
          NEVER_CANCELLED,
        );
      } catch (err) {
        this.log.warn(`Release notes for ${name} ${candidate.version}: ${errorMessage(err)}`);
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
   * Lets the user approve running a script source's program (SPEC §6.5). Shows a modal with
   * the exact command; `confirmed` skips it (integration tests only drive commands).
   */
  async approveScript(name?: string, confirmed = false): Promise<boolean> {
    await this.loadConfig();
    const scripts = [...this.sources.values()]
      .map((e) => e.source)
      .filter((s): s is ScriptSource => s instanceof ScriptSource);
    if (!name) {
      if (scripts.length === 0) {
        void vscode.window.showInformationMessage(
          this.config?.settings.scriptEnabled
            ? 'Leuchtturm: no script sources are configured.'
            : 'Leuchtturm: script sources are disabled ("leuchtturm.script.enabled").',
        );
        return false;
      }
      name = (
        await vscode.window.showQuickPick(
          scripts.map((s) => ({
            label: s.name,
            description: s.commandLine,
            detail: this.store.isScriptApproved(s.fingerprint) ? 'allowed' : 'not allowed yet',
          })),
          { title: 'Leuchtturm: Allow Script Source', placeHolder: 'Which script source?' },
        )
      )?.label;
      if (!name) {
        return false;
      }
    }
    const source = scripts.find((s) => s.name === name);
    if (!source) {
      void vscode.window.showErrorMessage(`Leuchtturm: "${name}" is not an enabled script source.`);
      return false;
    }
    if (!confirmed) {
      const ok = await vscode.window.showWarningMessage(
        `Allow Leuchtturm to run "${source.commandLine}"?`,
        {
          modal: true,
          detail:
            `Source "${name}" runs this program whenever Leuchtturm checks for or installs updates. ` +
            'Allow it only if you trust it. Changing the command or script path asks again.',
        },
        'Allow',
      );
      if (ok !== 'Allow') {
        return false;
      }
    }
    await this.store.approveScript(source.fingerprint);
    this.log.info(`Approved script source "${name}": ${source.commandLine}`);
    await this.check({ manual: false, sources: [name] });
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

    const text = await this.runTest(
      name,
      this.sources.get(name),
      invalid.find((p) => p.source === name)?.message,
    );
    this.log.info(text);
    this.log.show();
    return this.log.redactor.redact(text);
  }

  /**
   * Tests a source as it is being edited (not saved yet), for the source editor. Uses the
   * current settings otherwise.
   */
  async testDraft(name: string, raw: unknown): Promise<string> {
    const get = readRawSettings();
    const draft = { [name]: raw };
    const config = parseConfig((key) => (key === 'sources' ? draft : get(key)));
    const parsed = config.sources[0];
    const text = await this.runTest(
      name,
      parsed && this.createEntry(parsed, config),
      config.problems.find((p) => p.source === name)?.message ??
        (raw !== null && typeof raw === 'object' && (raw as { enabled?: unknown }).enabled === false
          ? 'The source is disabled.'
          : undefined),
    );
    this.log.info(text);
    return this.log.redactor.redact(text);
  }

  /**
   * Lists a source that is not saved, with the real implementation, for the guided setup.
   * Throws the configuration problem or listing error that a check would show.
   */
  async listDraft(name: string, raw: unknown): Promise<Artifact[]> {
    const get = readRawSettings();
    const config = parseConfig((key) => (key === 'sources' ? { [name]: raw } : get(key)));
    const parsed = config.sources[0];
    if (!parsed) {
      throw new Error(config.problems[0]?.message ?? 'The source is disabled.');
    }
    const entry = this.createEntry(parsed, config);
    this.log.debug(`Guided setup: listing ${JSON.stringify(raw)}`);
    return withTimeout(
      entry.timeoutMs,
      NEVER_CANCELLED,
      (t) => entry.source.list(t),
      `Source "${name}"`,
    );
  }

  /** Lists one source and describes everything it found (Test Source). */
  private async runTest(
    name: string,
    entry: SourceEntry | undefined,
    problem: string | undefined,
  ): Promise<string> {
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    out(`===== Test source "${name}" =====`);
    if (!entry) {
      out(problem ?? `No enabled source named "${name}".`);
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
    return lines.join('\n');
  }
}
