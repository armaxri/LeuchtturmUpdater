/**
 * `script` source (SPEC §6.5): runs a user program (Python preferred, any executable works)
 * and reads one JSON document per action from its stdout. stderr goes to the log.
 *
 * Security: scripts only run while `leuchtturm.script.enabled` is true in the *user*
 * settings (checked again before every spawn) and after the user approved this exact
 * command + script path once. Programs are started without a shell, with every argument
 * templated separately.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { errorMessage, type Logger } from '../log';
import type { CancellationToken } from '../util/cancellation';
import { httpDownload } from '../util/http';
import { validateJson, type JsonSchema } from '../util/jsonSchema';
import { runProcess } from '../util/process';
import { currentPlatform, expandTemplate } from '../util/template';
import { compareVersions } from '../version';
import type { ScriptAction, ScriptSourceConfig } from './scriptConfig';
import {
  ActionableError,
  type Artifact,
  type AvailableVersion,
  type Reporter,
  type Source,
} from './types';

export const SCRIPTS_DISABLED_MESSAGE =
  'Script sources are disabled — enable "leuchtturm.script.enabled" in your user settings';

export const OPEN_SCRIPT_SETTING = {
  title: 'Open User Settings',
  command: 'workbench.action.openGlobalSettings',
  arguments: [{ query: 'leuchtturm.script.enabled' }],
};

/** Exit code a script uses for "this action is not supported" (only for `notes`). */
const EXIT_NOT_SUPPORTED = 3;
const REPORT_STDOUT_CHARS = 4096;

/** What the script source needs from the extension to decide whether it may run. */
export interface ScriptGate {
  /** Live user-level value of `leuchtturm.script.enabled`. */
  enabled(): boolean;
  isApproved(fingerprint: string): boolean;
  /** Asks the user to approve (non-blocking, at most once per session and fingerprint). */
  requestApproval(sourceName: string, fingerprint: string, commandLine: string): void;
}

export interface ScriptHost {
  gate: ScriptGate;
  schema: JsonSchema;
  /** VS Code version, passed to scripts as LEUCHTTURM_VSCODE_VERSION. */
  hostVersion: string;
  addSecret: (value: string) => void;
}

/** Identifies what the user approved: the executable and the script path. */
export function scriptFingerprint(config: Pick<ScriptSourceConfig, 'command' | 'script'>): string {
  return createHash('sha256')
    .update(`${config.command}\0${config.script ?? ''}`)
    .digest('hex');
}

/**
 * Parses stdout. It must hold one JSON document; if a script printed extra lines, the last
 * line that is valid JSON wins and a warning is returned.
 */
export function parseScriptOutput(stdout: string): { value: unknown; warning?: string } {
  const text = stdout.trim();
  if (text === '') {
    throw new Error('The script printed nothing on stdout (expected one JSON document)');
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const value: unknown = JSON.parse(lines[i]!);
        if (value !== null && typeof value === 'object') {
          return {
            value,
            warning:
              'The script printed more than one JSON document; using the last JSON line. Write logs to stderr.',
          };
        }
      } catch {
        // keep looking
      }
    }
  }
  throw new Error(`The script's stdout is not JSON: ${text.slice(0, 200)}`);
}

function envKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

interface ListResponse {
  artifacts: {
    id: string;
    displayName?: string;
    versions: {
      version: string;
      releaseNotes?: string;
      releaseNotesUrl?: string;
      sha256?: string;
      ref?: Record<string, string>;
    }[];
  }[];
}

type DownloadResponse = { path: string } | { url: string; headers?: Record<string, string> };

export class ScriptSource implements Source {
  readonly type = 'script' as const;
  readonly name: string;
  readonly fingerprint: string;

  constructor(
    private readonly config: ScriptSourceConfig,
    private readonly timeoutMs: number,
    private readonly log: Logger,
    private readonly host: ScriptHost,
  ) {
    this.name = config.name;
    this.fingerprint = scriptFingerprint(config);
  }

  get commandLine(): string {
    return [this.config.command, this.config.script].filter(Boolean).join(' ');
  }

  /** Checked right before every spawn, so turning the setting off takes effect at once. */
  private ensureAllowed(): void {
    const { gate } = this.host;
    if (!gate.enabled()) {
      throw new ActionableError(SCRIPTS_DISABLED_MESSAGE, OPEN_SCRIPT_SETTING);
    }
    if (!gate.isApproved(this.fingerprint)) {
      gate.requestApproval(this.name, this.fingerprint, this.commandLine);
      throw new ActionableError(`Waiting for your approval to run "${this.commandLine}"`, {
        title: 'Review and Allow…',
        command: 'leuchtturm.approveScript',
        arguments: [this.name],
      });
    }
  }

  private async run(
    action: ScriptAction,
    vars: Record<string, string>,
    ref: Record<string, string>,
    token: CancellationToken,
    report: (line: string) => void = () => undefined,
  ): Promise<unknown> {
    const template = this.config.args[action];
    if (!template) {
      return undefined;
    }
    this.ensureAllowed();
    const ctx = { ...this.config.templateContext, vars, ref };
    const args = template.map((a) => expandTemplate(a, ctx));
    if (this.config.script) {
      args.unshift(this.config.script);
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.config.env)) {
      env[k] = expandTemplate(v, ctx);
    }
    Object.assign(env, {
      LEUCHTTURM_PROTOCOL: '1',
      LEUCHTTURM_ACTION: action,
      LEUCHTTURM_VSCODE_VERSION: this.host.hostVersion,
      LEUCHTTURM_PLATFORM: currentPlatform(),
    });
    if (vars.id) {
      env.LEUCHTTURM_ID = vars.id;
    }
    if (vars.version) {
      env.LEUCHTTURM_VERSION = vars.version;
    }
    if (vars.targetDir) {
      env.LEUCHTTURM_TARGET_DIR = vars.targetDir;
    }
    for (const [k, v] of Object.entries(ref)) {
      env[`LEUCHTTURM_REF_${envKey(k)}`] = v;
    }

    // JSON.stringify shows exactly what each argument is, spaces included.
    const shown = [this.config.command, ...args].map((a) => JSON.stringify(a)).join(' ');
    this.log.debug(`[${this.name}] run ${action}: ${shown}`);
    report(`$ ${shown}${this.config.cwd ? `   (cwd ${this.config.cwd})` : ''}`);
    const start = Date.now();
    const result = await runProcess({
      command: this.config.command,
      args,
      cwd: this.config.cwd,
      env,
      timeoutMs: this.timeoutMs,
      token,
      onStderrLine: (line) => {
        this.log.debug(`[${this.name}] stderr: ${line}`);
        report(`  stderr: ${line}`);
      },
    });
    this.log.debug(
      `[${this.name}] exit ${result.code} after ${Date.now() - start} ms; stdout: ${result.stdout.trim()}`,
    );
    report(`  exit code ${result.code ?? result.signal} after ${Date.now() - start} ms`);
    report(`  stdout: ${result.stdout.trim().slice(0, REPORT_STDOUT_CHARS) || '(empty)'}`);

    if (action === 'notes' && result.code === EXIT_NOT_SUPPORTED) {
      return undefined;
    }
    const lastStderr = result.stderr.trim().split(/\r?\n/).pop();
    let parsed: { value: unknown; warning?: string };
    try {
      parsed = parseScriptOutput(result.stdout);
    } catch (err) {
      // A crash usually prints no JSON; the exit code and stderr say more than "not JSON".
      if (result.code !== 0) {
        throw new Error(
          `exited with code ${result.code ?? result.signal}${lastStderr ? `: ${lastStderr}` : ''}`,
          { cause: err },
        );
      }
      throw err;
    }
    if (parsed.warning) {
      this.log.warn(`[${this.name}] ${parsed.warning}`);
      report(`  WARNING: ${parsed.warning}`);
    }
    const value = parsed.value as Record<string, unknown>;
    if (value && typeof value === 'object' && 'error' in value) {
      const errors = validateJson(this.host.schema, value, 'error');
      if (errors.length === 0) {
        if (typeof value.detail === 'string') {
          this.log.warn(`[${this.name}] ${value.error as string}: ${value.detail}`);
          report(`  detail: ${value.detail}`);
        }
        throw new Error(value.error as string);
      }
    }
    if (result.code !== 0) {
      throw new Error(
        `exited with code ${result.code ?? result.signal}${lastStderr ? `: ${lastStderr}` : ''}`,
      );
    }
    const errors = validateJson(this.host.schema, value, action);
    if (errors.length > 0) {
      for (const e of errors) {
        this.log.warn(`[${this.name}] invalid ${action} response: ${e}`);
        report(`  INVALID: ${e}`);
      }
      throw new Error(
        `Invalid response to "${action}": ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more, see log)` : ''}`,
      );
    }
    return value;
  }

  async list(token: CancellationToken, report: Reporter = () => undefined): Promise<Artifact[]> {
    const response = (await this.run('list', {}, {}, token, report)) as ListResponse;
    const onDemand = this.config.args.notes !== null;
    return response.artifacts.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      kind: 'vscode-extension' as const,
      versions: a.versions
        .map((v) => ({
          version: v.version,
          releaseNotes: v.releaseNotes,
          releaseNotesUrl: v.releaseNotesUrl,
          releaseNotesOnDemand: onDemand && !v.releaseNotes,
          sha256: v.sha256?.toLowerCase(),
          ref: v.ref ?? {},
        }))
        .sort((x, y) => compareVersions(y.version, x.version)),
    }));
  }

  async download(
    artifact: Artifact,
    version: AvailableVersion,
    targetDir: string,
    token: CancellationToken,
  ): Promise<string> {
    await fs.mkdir(targetDir, { recursive: true });
    const vars = { id: artifact.id, version: version.version, targetDir };
    const response = (await this.run('download', vars, version.ref, token)) as DownloadResponse;
    const dest = path.join(targetDir, `${artifact.id}-${version.version}.vsix`);

    if ('path' in response) {
      const file = path.resolve(targetDir, response.path);
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat?.isFile()) {
        throw new Error(`The script returned "${response.path}", which is not a file`);
      }
      // A file outside the download folder belongs to someone else: copy it rather than
      // letting the installer clean it up afterwards.
      const rel = path.relative(targetDir, file);
      const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
      if (inside) {
        return file;
      }
      await fs.copyFile(file, dest);
      return dest;
    }

    // URL: Leuchtturm downloads it. Header values are usually credentials.
    const headers = response.headers ?? {};
    Object.values(headers).forEach((v) => this.host.addSecret(v));
    this.log.info(`[${this.name}] downloading ${response.url}`);
    await httpDownload(response.url, dest, {
      headers,
      timeoutMs: Math.max(this.timeoutMs * 10, 5 * 60_000),
      token,
    });
    return dest;
  }

  async fetchReleaseNotes(
    artifact: Artifact,
    version: AvailableVersion,
    token: CancellationToken,
  ): Promise<string | undefined> {
    try {
      const response = (await this.run(
        'notes',
        { id: artifact.id, version: version.version },
        version.ref,
        token,
      )) as { markdown: string } | undefined;
      return response?.markdown;
    } catch (err) {
      this.log.warn(`[${this.name}] release notes: ${errorMessage(err)}`);
      throw err;
    }
  }
}
