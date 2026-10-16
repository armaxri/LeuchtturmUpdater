/**
 * `npm run test:remote`: the demo scenario in a Dev Containers window (needs Docker).
 *
 * Opens the scenario workspace inside a container. Leuchtturm's development build runs on the
 * local side (it is a UI extension), and so does the mocha suite in ./suite, which checks the
 * container's extensions folder with `docker exec`. The container is removed afterwards.
 */

import * as path from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

import {
  DEV_CONTAINER_SETTINGS,
  DEV_CONTAINERS_EXTENSION,
  pinDockerEngine,
  prepareDevContainer,
  removeDevContainers,
  runCodeCli,
} from '../devContainer';
import { ROOT } from '../packageFixture';
import { buildScenario } from '../scenario';

async function main(): Promise<void> {
  // Pessimistic until proven otherwise: if cleanup ever hangs on a promise that never settles,
  // Node exits once nothing is left to do, and that must not look like a passing run.
  process.exitCode = 1;
  pinDockerEngine();
  // Inside the repository, not in os.tmpdir(): the macOS temp path is too long for VS Code's
  // IPC socket, and Docker Desktop shares /Users with containers by default.
  const scenario = await buildScenario(path.join(ROOT, '.remote-test'), {
    'leuchtturm.checkOnStartup': false,
    'leuchtturm.checkInterval': 0,
    'leuchtturm.notify': false,
    ...DEV_CONTAINER_SETTINGS,
  });
  try {
    // A container left over from an aborted run would be reused, with its old extensions.
    removeDevContainers(scenario.workspace);
    const folderUri = await prepareDevContainer(scenario.workspace);
    const profile = [
      '--user-data-dir',
      scenario.userDataDir,
      '--extensions-dir',
      scenario.extensionsDir,
    ];
    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    await runCodeCli(cli!, [
      ...cliArgs,
      ...profile,
      '--install-extension',
      DEV_CONTAINERS_EXTENSION,
    ]);

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        `--folder-uri=${folderUri}`,
        ...profile,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      // The suite runs `docker` too; it inherits DOCKER_HOST from this process.
      extensionTestsEnv: { ...scenario.env, LEUCHTTURM_IT_HOST_WORKSPACE: scenario.workspace },
    });
  } finally {
    removeDevContainers(scenario.workspace);
    await scenario.close();
  }
  process.exitCode = 0;
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Remote test failed:', err);
  process.exit(1);
});
