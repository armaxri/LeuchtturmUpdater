/**
 * Integration test launcher (runs in plain Node, not inside VS Code).
 *
 * 1. Builds the demo scenario (see ../scenario.ts) in a temp folder.
 * 2. Downloads VS Code (cached in .vscode-test/) and pre-installs the old demo version.
 * 3. Opens the scenario workspace and runs the mocha suite inside VS Code.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

import { ROOT } from '../packageFixture';
import { buildScenario } from '../scenario';

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-it-'));
  try {
    const scenario = await buildScenario(path.join(tmp, 's'), {
      // No timers or pop-ups during tests; the suite triggers checks itself.
      'leuchtturm.checkOnStartup': false,
      'leuchtturm.checkInterval': 0,
      'leuchtturm.notify': false,
    });
    const profile = [
      '--user-data-dir',
      scenario.userDataDir,
      '--extensions-dir',
      scenario.extensionsDir,
    ];

    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    for (const vsix of scenario.preinstall) {
      const r = spawnSync(cli!, [...cliArgs, ...profile, '--install-extension', vsix], {
        encoding: 'utf8',
        // The Windows CLI is a .cmd file, which needs a shell.
        shell: process.platform === 'win32',
      });
      if (r.status !== 0) {
        throw new Error(`Pre-installing ${vsix} failed:\n${r.stdout}\n${r.stderr}`);
      }
    }

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        scenario.workspace,
        ...profile,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: { LEUCHTTURM_IT_EXTENSIONS_DIR: scenario.extensionsDir },
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Integration tests failed:', err);
  process.exit(1);
});
