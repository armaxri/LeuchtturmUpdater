/**
 * Integration test launcher (runs in plain Node, not inside VS Code).
 *
 * 1. Builds the demo scenario (see ../scenario.ts) in a temp folder.
 * 2. Downloads VS Code (cached in .vscode-test/) and pre-installs the old demo version.
 * 3. Opens the scenario workspace and runs the mocha suite inside VS Code.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

import { ROOT } from '../packageFixture';
import { removeTempDir } from '../paths';
import { runCodeSync } from '../codeCli';
import { buildScenario } from '../scenario';

async function main(): Promise<void> {
  // Pessimistic until proven otherwise: if cleanup ever hangs on a promise that never settles,
  // Node exits once nothing is left to do, and that must not look like a passing run.
  process.exitCode = 1;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-it-'));
  try {
    const scenario = await buildScenario(path.join(tmp, 's'), {
      // No timers or pop-ups during tests; the suite triggers checks itself.
      'leuchtturm.checkOnStartup': false,
      'leuchtturm.checkInterval': 0,
      'leuchtturm.notify': false,
    });
    if (!scenario.python) {
      throw new Error(
        'The integration tests need Python ≥ 3.8 (python3, python or py) on the PATH',
      );
    }
    const profile = [
      '--user-data-dir',
      scenario.userDataDir,
      '--extensions-dir',
      scenario.extensionsDir,
    ];

    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    // The CLI path only: our own profile arguments replace test-electron's default profile
    // (passing both made VS Code warn "Option user-data-dir is defined more than once").
    const cli = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
    for (const vsix of scenario.preinstall) {
      const r = runCodeSync(cli, [...profile, '--install-extension', vsix]);
      if (r.status !== 0) {
        throw new Error(`Pre-installing ${vsix} failed:\n${r.stdout}\n${r.stderr}`);
      }
    }

    try {
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
        extensionTestsEnv: {
          ...scenario.env,
          LEUCHTTURM_IT_EXTENSIONS_DIR: scenario.extensionsDir,
          LEUCHTTURM_IT_PROXY: scenario.proxyUrl,
        },
      });
    } catch (err) {
      await saveExtensionLog(scenario.userDataDir);
      throw err;
    } finally {
      await scenario.close();
    }
  } finally {
    await removeTempDir(tmp);
  }
  process.exitCode = 0;
}

/**
 * Prints Leuchtturm's own log (VS Code writes each extension's output channel to a file in the
 * profile) and saves it to .test-failures/, which CI uploads: the assertion alone rarely says
 * why a check or an install went differently.
 */
async function saveExtensionLog(userDataDir: string): Promise<void> {
  const logs = path.join(userDataDir, 'logs');
  const files = (await fs.readdir(logs, { recursive: true }).catch(() => []))
    .filter((f) => f.includes('leuchtturm-updater') && f.endsWith('.log'))
    .map((f) => path.join(logs, f));
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    // eslint-disable-next-line no-console
    console.error(`\n--- ${path.relative(logs, file)} ---\n${text}`);
    await fs.mkdir(path.join(ROOT, '.test-failures'), { recursive: true });
    await fs.writeFile(
      path.join(ROOT, '.test-failures', `integration-${path.basename(file)}`),
      text,
    );
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Integration tests failed:', err);
  process.exit(1);
});
