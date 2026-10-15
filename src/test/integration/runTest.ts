/**
 * Integration test launcher (runs in plain Node, not inside VS Code).
 *
 * 1. Packages the fixture extension into a temporary "file share" at two versions.
 * 2. Writes user settings that point Leuchtturm at that share.
 * 3. Downloads VS Code (cached in .vscode-test/) and runs the mocha suite inside it.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';
import { createVSIX } from '@vscode/vsce';

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(ROOT, 'test/fixtures/sample-extension');

async function packageFixture(version: string, share: string, work: string): Promise<void> {
  const dir = path.join(work, `sample-${version}`);
  await fs.cp(FIXTURE, dir, { recursive: true });
  const manifestPath = path.join(dir, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version: string };
  manifest.version = version;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  // `dependencies: false` is accepted at runtime but missing from the published types.
  const options = {
    cwd: dir,
    packagePath: path.join(share, `leuchtturm-test.sample-${version}.vsix`),
    allowMissingRepository: true,
    skipLicense: true,
    dependencies: false,
  };
  await createVSIX(options);
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-it-'));
  try {
    const share = path.join(tmp, 'share');
    const userDataDir = path.join(tmp, 'user-data');
    const extensionsDir = path.join(tmp, 'extensions');
    await fs.mkdir(share, { recursive: true });
    await fs.mkdir(path.join(userDataDir, 'User'), { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });

    for (const version of ['1.0.0', '1.1.0']) {
      await packageFixture(version, share, path.join(tmp, 'work'));
    }

    // Sources are only read from user settings, so the test writes them there.
    const userSettings = {
      'leuchtturm.checkOnStartup': false,
      'leuchtturm.checkInterval': 0,
      'leuchtturm.notify': false,
      'leuchtturm.sources': { share: { type: 'file', path: share } },
      'leuchtturm.extensions': ['leuchtturm-test.sample'],
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
    };
    await fs.writeFile(
      path.join(userDataDir, 'User', 'settings.json'),
      JSON.stringify(userSettings, null, 2),
    );

    await runTests({
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        LEUCHTTURM_IT_EXTENSIONS_DIR: extensionsDir,
        LEUCHTTURM_IT_SHARE: share,
      },
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
