/** Packages a fixture extension into a `.vsix` at a given version (shared by tests and sandbox). */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createVSIX } from '@vscode/vsce';

export { ROOT } from './paths';

/**
 * Copies `fixtureDir` to a temp folder, overrides `package.json` fields (at least `version`),
 * and writes the packaged extension to `outFile`.
 */
export async function packageFixture(
  fixtureDir: string,
  manifestOverrides: { version: string; [key: string]: unknown },
  outFile: string,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-fixture-'));
  try {
    await fs.cp(fixtureDir, dir, { recursive: true });
    const manifestPath = path.join(dir, 'package.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as object;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, ...manifestOverrides }, null, 2),
    );
    // Everything in a fixture belongs into its package; an (empty) ignore file says so, and
    // stops vsce from warning that there is none.
    await fs.writeFile(path.join(dir, '.vscodeignore'), '', { flag: 'a' });
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    // `dependencies: false` is accepted at runtime but missing from the published types.
    const options = {
      cwd: dir,
      packagePath: outFile,
      allowMissingRepository: true,
      skipLicense: true,
      dependencies: false,
    };
    await createVSIX(options);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
