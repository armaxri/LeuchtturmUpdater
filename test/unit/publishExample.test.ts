/**
 * Runs examples/npm/publish.sh in pack-only mode and reads the result with Leuchtturm's own
 * tarball code, so the documented publishing workflow is known to produce what the `npm`
 * source expects.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findRootVsix } from '../../src/sources/npmSource';
import { ROOT } from '../../src/test/paths';
import { readTgz } from '../../src/util/tar';
import { tempDir } from './helpers';

const hasSh = process.platform !== 'win32';

describe.skipIf(!hasSh)('examples/npm/publish.sh', () => {
  it('packs a .vsix into a package the npm source understands', async () => {
    const dir = await tempDir();
    const vsix = path.join(dir, 'corp.my-linter-2.0.0-beta.1.vsix');
    await fs.writeFile(vsix, 'fake vsix');
    execFileSync('sh', [path.join(ROOT, 'examples/npm/publish.sh'), vsix], {
      cwd: dir,
      env: { ...process.env, PACK_ONLY: '1', PACKAGE_SCOPE: '@corp-vscode' },
      stdio: 'pipe',
    });
    const tgz = (await fs.readdir(dir)).find((f) => f.endsWith('.tgz'));
    expect(tgz).toBe('corp-vscode-my-linter-2.0.0-beta.1.tgz');
    const entries = await readTgz(await fs.readFile(path.join(dir, tgz!)));
    expect(findRootVsix(entries).name).toBe('package/corp.my-linter-2.0.0-beta.1.vsix');
    const manifest = JSON.parse(
      entries.find((e) => e.name === 'package/package.json')!.data.toString(),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: '@corp-vscode/my-linter',
      version: '2.0.0-beta.1',
      vscodeExtension: 'corp.my-linter',
    });
  }, 60_000);
});
