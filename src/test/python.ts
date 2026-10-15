import { spawnSync } from 'node:child_process';

/**
 * Finds a Python ≥ 3.8 to run the script examples with: `python3`, `python`, or the Windows
 * launcher `py`. Returns undefined if there is none (tests that need it are then skipped).
 */
export function findPython(): string | undefined {
  for (const command of ['python3', 'python', 'py']) {
    const r = spawnSync(command, ['-c', 'import sys; print(sys.version_info >= (3, 8))'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim() === 'True') {
      return command;
    }
  }
  return undefined;
}
