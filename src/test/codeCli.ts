/**
 * Runs VS Code's command line (`code`) without a shell.
 *
 * On Windows, `code` is a batch file (`bin\code.cmd`), and batch files only run through
 * cmd.exe, which parses the arguments again; Node warns about that (DEP0190). The batch file
 * does nothing but start `Code.exe` as plain Node (`ELECTRON_RUN_AS_NODE=1`) on `cli.js`, so
 * we read those two paths from it and start them directly. Elsewhere `code` is a script with a
 * `#!` line, which runs without a shell anyway.
 */

import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface CodeCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** What to spawn for `cli args…`; `cli` is a path or, like `code`, a name on the PATH. */
export function codeCommand(
  cli: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CodeCommand {
  if (process.platform !== 'win32' || !cli.toLowerCase().endsWith('.cmd')) {
    return { file: cli, args, env };
  }
  const script = findOnPath(cli, env);
  // e.g. `"%~dp0..\Code.exe" "%~dp0..\resources\app\out\cli.js" %*`
  // (%~dp0 is the batch file's own folder).
  const m = /"%~dp0([^"]+\.exe)"\s+"%~dp0([^"]+\.js)"/i.exec(readFileSync(script, 'utf8'));
  if (!m) {
    throw new Error(`${script} does not look like VS Code's command line`);
  }
  const dir = path.dirname(script);
  return {
    file: path.resolve(dir, m[1]!),
    args: [path.resolve(dir, m[2]!), ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: undefined },
  };
}

/** `spawnSync` for the VS Code CLI; returns its output as text. */
export function runCodeSync(cli: string, args: string[]) {
  const c = codeCommand(cli, args);
  return spawnSync(c.file, c.args, { env: c.env, encoding: 'utf8' });
}

/** `spawn` for the VS Code CLI. */
export function spawnCode(cli: string, args: string[], options: SpawnOptions = {}) {
  const c = codeCommand(cli, args, options.env ?? process.env);
  return spawn(c.file, c.args, { ...options, env: c.env });
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(name) || name.includes(path.sep)) {
    return name;
  }
  // Windows spells the variable `Path`; `env` is a plain object there, so look up both.
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const found = dirs.map((d) => path.join(d, name)).find((p) => existsSync(p));
  if (!found) {
    throw new Error(`"${name}" is not on the PATH. Set CODE_CLI to the VS Code CLI.`);
  }
  return found;
}
