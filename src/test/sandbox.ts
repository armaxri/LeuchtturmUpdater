/**
 * `npm run sandbox`: prepares the demo scenario in `.sandbox/` and opens a VS Code window
 * running the development build of Leuchtturm with an isolated profile. Keeps running to
 * serve the fake Jenkins and web server until you press Ctrl+C.
 *
 * Flags:
 *   --no-launch       prepare everything but do not open VS Code (used to validate the setup)
 *   --dev-container   open the workspace in a Dev Containers window (needs Docker); the
 *                     container is removed when you stop the sandbox
 *   --jenkins         also start a real Jenkins in Docker with a pipeline that builds a new
 *                     version of a demo extension on "Build Now" (`npm run full-sandbox`)
 *
 * Environment:
 *   CODE_CLI      VS Code CLI to use (default: `code`, or `code.cmd` on Windows)
 */

import * as path from 'node:path';

import {
  DEV_CONTAINER_SETTINGS,
  DEV_CONTAINERS_EXTENSION,
  pinDockerEngine,
  prepareDevContainer,
  removeDevContainers,
} from './devContainer';
import { spawnCode } from './codeCli';
import { JENKINS_EXTENSION_ID, startJenkins, type DockerJenkins } from './dockerJenkins';
import { ROOT } from './packageFixture';
import { buildScenario, demo } from './scenario';

const isWindows = process.platform === 'win32';
const CODE = process.env.CODE_CLI ?? (isWindows ? 'code.cmd' : 'code');

function run(args: string[], detached = false, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnCode(CODE, args, {
      stdio: detached ? 'ignore' : 'inherit',
      detached,
      env: { ...process.env, ...env },
    });
    child.on('error', (err) =>
      reject(new Error(`Cannot run "${CODE}" (${err.message}). Set CODE_CLI to the VS Code CLI.`)),
    );
    if (detached) {
      child.unref();
      resolve();
    } else {
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${CODE} ${args[0]} exited with ${code}`)),
      );
    }
  });
}

async function main(): Promise<void> {
  const launch = !process.argv.includes('--no-launch');
  const devContainer = process.argv.includes('--dev-container');
  const withJenkins = process.argv.includes('--jenkins');
  if (devContainer || withJenkins) {
    pinDockerEngine();
  }
  const scenario = await buildScenario(
    path.join(ROOT, '.sandbox'),
    devContainer ? DEV_CONTAINER_SETTINGS : {},
  );
  const profile = [
    '--user-data-dir',
    scenario.userDataDir,
    '--extensions-dir',
    scenario.extensionsDir,
  ];

  // Version 1.0.0 of the extension the Jenkins pipeline builds, so its first build (1.1.0)
  // shows up as an update.
  const preinstall = [...scenario.preinstall];
  if (withJenkins) {
    preinstall.push(
      await demo(
        'jenkins',
        'Leuchtturm Demo Jenkins',
        '1.0.0',
        path.join(scenario.root, 'jenkins', `${JENKINS_EXTENSION_ID}-1.0.0.vsix`),
      ),
    );
  }
  // In a container window, extensions start out uninstalled on the container side.
  for (const vsix of devContainer ? [] : preinstall) {
    await run([...profile, '--install-extension', vsix, '--force']);
  }
  const folderUri = devContainer ? await prepareDevContainer(scenario.workspace) : undefined;
  if (devContainer) {
    await run([...profile, '--install-extension', DEV_CONTAINERS_EXTENSION]);
  }

  /* eslint-disable no-console */
  let jenkins: DockerJenkins | undefined;
  if (withJenkins) {
    jenkins = await startJenkins((line) => console.log(line));
  }
  console.log(`\nSandbox ready in ${scenario.root}`);
  if (!scenario.python) {
    console.log('No Python ≥ 3.8 found: the script source demo is left out.');
  }
  if (!launch) {
    jenkins?.close();
    await scenario.close();
    return;
  }
  await run(
    [
      ...profile,
      '--new-window',
      `--extensionDevelopmentPath=${ROOT}`,
      '--log',
      'armaxri.leuchtturm-updater:debug',
      ...(folderUri
        ? [`--folder-uri=${folderUri}`]
        : [scenario.workspace, path.join(scenario.workspace, 'TRY-ME.md')]),
    ],
    true,
    // The demo's company CA and npm configuration (see Scenario.env).
    scenario.env,
  );
  console.log(
    devContainer
      ? 'VS Code is starting the dev container (the first time takes a minute). Open TRY-ME.md ' +
          'there and follow "Remote windows".'
      : 'VS Code is starting. Follow TRY-ME.md in the new window.',
  );
  console.log(`Fake Jenkins:    ${scenario.jenkinsUrl}/job/demo-ci/`);
  console.log(`Jenkins with login (for "needs a login"): ${scenario.protectedJenkinsUrl}`);
  console.log(`Fake web server: ${scenario.webUrl}/vsix/`);
  console.log(`Fake npm registry: ${scenario.npmUrl}  (npm is configured in .sandbox/npmrc)`);
  console.log(`Fake proxy (http.proxy): ${scenario.proxyUrl}`);
  if (jenkins) {
    console.log('');
    console.log(`Jenkins (Docker):  ${jenkins.jobUrl}`);
    console.log(
      '  Click "Build Now" there: every build is a new version of Leuchtturm Demo Jenkins.',
    );
    console.log(
      '  Then paste that link into Leuchtturm\'s "Add Source" (see TRY-ME.md, "Full sandbox").',
    );
  }
  console.log('Keep this running while you try things. Press Ctrl+C to stop the servers.');
  /* eslint-enable no-console */
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  await scenario.close();
  if (jenkins) {
    console.log('Removing the Jenkins container…'); // eslint-disable-line no-console
    jenkins.close();
  }
  if (devContainer) {
    console.log('Removing the dev container…'); // eslint-disable-line no-console
    removeDevContainers(scenario.workspace);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
