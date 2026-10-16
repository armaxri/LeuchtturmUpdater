/**
 * Runs the user's own npm CLI. The `npm` source uses it so that whatever the user configured
 * for npm (registries in `.npmrc`, `npm login`, company proxies and certificates) just works,
 * without Leuchtturm reading or handling any of it.
 *
 * Always without a shell (see process.ts). On Windows `npm` is a `.cmd` script, which Node no
 * longer starts without a shell, so there we run npm's own `npm-cli.js` with the `node.exe`
 * next to it, which is exactly what `npm.cmd` does.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import type { CancellationToken } from './cancellation';
import { runProcess, type RunResult } from './process';

export class NpmNotFoundError extends Error {
  override name = 'NpmNotFoundError';
  constructor() {
    super(
      'npm was not found on the PATH. Install Node.js (which includes npm), or make sure ' +
        'VS Code sees it (restart VS Code after installing).',
    );
  }
}

export interface NpmCommand {
  command: string;
  /** Arguments that come before npm's own (Windows: the path of npm-cli.js). */
  prefix: string[];
}

/** Finds `name` in the PATH directories. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, name)).find((p) => existsSync(p));
}

/** How to start npm on this machine, or throws `NpmNotFoundError`. */
export function resolveNpm(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NpmCommand {
  if (platform !== 'win32') {
    const npm = onPath('npm', env);
    if (!npm) {
      throw new NpmNotFoundError();
    }
    return { command: npm, prefix: [] };
  }
  const cmd = onPath('npm.cmd', env);
  if (!cmd) {
    throw new NpmNotFoundError();
  }
  const dir = path.dirname(cmd);
  const node = path.join(dir, 'node.exe');
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(node) || !existsSync(cli)) {
    throw new Error(`Found ${cmd}, but not the node.exe and npm-cli.js that belong to it`);
  }
  return { command: node, prefix: [cli] };
}

export interface NpmRunOptions {
  timeoutMs: number;
  token: CancellationToken;
  cwd?: string;
  onStderrLine?: (line: string) => void;
}

/** Runs `npm <args>`; throws with npm's own error message if it fails. */
export async function runNpm(args: string[], options: NpmRunOptions): Promise<RunResult> {
  const npm = resolveNpm();
  const result = await runProcess({
    command: npm.command,
    args: [...npm.prefix, ...args],
    // The user's environment, so npm finds its configuration (NPM_CONFIG_*, HOME, …).
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    ...options,
  });
  if (result.code !== 0) {
    throw new Error(`npm ${args[0]} failed: ${npmErrorSummary(result)}`);
  }
  return result;
}

/** The useful part of npm's error output (`npm error …` lines, without the log hint). */
export function npmErrorSummary(result: Pick<RunResult, 'stdout' | 'stderr' | 'code'>): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((l) => l.replace(/^npm (?:error|ERR!)\s*/, '').trim())
    .filter((l) => l && !/complete log of this run|^\{|^\}|"(?:summary|detail|error)"/.test(l));
  return lines.slice(0, 3).join(' ') || `exit code ${String(result.code)}`;
}
