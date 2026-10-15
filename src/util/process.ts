/**
 * Runs an external program with `spawn` and **no shell**: every argument is passed as is, so
 * nothing in a version string or URL can be interpreted as shell syntax. Kills the whole
 * process tree on timeout or cancellation.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { CancelledError, TimeoutError, type CancellationToken } from './cancellation';

export interface RunOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  token: CancellationToken;
  /** Called for every complete line on stderr. */
  onStderrLine?: (line: string) => void;
  /** Abort if stdout grows beyond this. Default 32 MB. */
  maxStdoutBytes?: number;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Kills a process and its children. On POSIX the child leads its own process group
 * (`detached`), so a negative PID reaches the group; on Windows `taskkill /T` walks the tree.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 3000).unref();
}

export function runProcess(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.token.isCancellationRequested) {
      reject(new CancelledError());
      return;
    }
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const maxStdout = options.maxStdoutBytes ?? 32 * 1024 * 1024;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let pendingLine = '';
    let failure: Error | undefined;

    const fail = (err: Error): void => {
      failure ??= err;
      killTree(child);
    };
    const timer = setTimeout(
      () => fail(new TimeoutError(`Timed out after ${Math.round(options.timeoutMs / 1000)} s`)),
      options.timeoutMs,
    );
    const sub = options.token.onCancellationRequested(() => fail(new CancelledError()));

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        fail(new Error(`Output larger than ${Math.round(maxStdout / 1024 / 1024)} MB`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      stderr += text;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      lines.forEach((l) => options.onStderrLine?.(l));
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      failure ??=
        err.code === 'ENOENT'
          ? new Error(`Command not found: "${options.command}" (is it installed and on the PATH?)`)
          : err;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      sub.dispose();
      if (pendingLine) {
        options.onStderrLine?.(pendingLine);
      }
      if (failure) {
        reject(failure);
      } else {
        resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr });
      }
    });
  });
}
