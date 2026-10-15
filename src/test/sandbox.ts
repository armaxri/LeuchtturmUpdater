/**
 * `npm run sandbox`: prepares the demo scenario in `.sandbox/` and opens a VS Code window
 * running the development build of Leuchtturm with an isolated profile. Keeps running to
 * serve the fake Jenkins and web server until you press Ctrl+C.
 *
 * Flags:
 *   --no-launch   prepare everything but do not open VS Code (used to validate the setup)
 *
 * Environment:
 *   CODE_CLI      VS Code CLI to use (default: `code`, or `code.cmd` on Windows)
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { ROOT } from './packageFixture';
import { buildScenario } from './scenario';

const isWindows = process.platform === 'win32';
const CODE = process.env.CODE_CLI ?? (isWindows ? 'code.cmd' : 'code');

function run(args: string[], detached = false): Promise<void> {
  return new Promise((resolve, reject) => {
    // `shell` only on Windows, where `.cmd` files cannot be spawned directly.
    const child = spawn(CODE, args, {
      stdio: detached ? 'ignore' : 'inherit',
      detached,
      shell: isWindows,
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
  const scenario = await buildScenario(path.join(ROOT, '.sandbox'));
  const profile = [
    '--user-data-dir',
    scenario.userDataDir,
    '--extensions-dir',
    scenario.extensionsDir,
  ];

  for (const vsix of scenario.preinstall) {
    await run([...profile, '--install-extension', vsix, '--force']);
  }

  /* eslint-disable no-console */
  console.log(`\nSandbox ready in ${scenario.root}`);
  if (!launch) {
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
      scenario.workspace,
      path.join(scenario.workspace, 'TRY-ME.md'),
    ],
    true,
  );
  console.log('VS Code is starting. Follow TRY-ME.md in the new window.');
  console.log(`Fake Jenkins:    ${scenario.jenkinsUrl}  (user "demo", password "demo-password")`);
  console.log(`Fake web server: ${scenario.webUrl}/vsix/`);
  console.log(`Fake npm registry: ${scenario.npmUrl}  (token in .sandbox/npmrc)`);
  console.log('Keep this running while you try things. Press Ctrl+C to stop the servers.');
  /* eslint-enable no-console */
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  await scenario.close();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
