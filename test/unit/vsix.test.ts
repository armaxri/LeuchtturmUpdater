import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageFixture } from '../../src/test/packageFixture';
import { ROOT } from '../../src/test/paths';
import { makeVsix, makeZip } from '../../src/test/zip';
import { readVsixManifest, verifyVsix } from '../../src/util/vsix';
import { listZip, readZipEntry } from '../../src/util/zip';
import { tempDir } from './helpers';

async function write(name: string, data: Buffer): Promise<string> {
  const file = path.join(await tempDir(), name);
  await fs.writeFile(file, data);
  return file;
}

describe('zip reader', () => {
  it('reads stored and deflated entries', async () => {
    for (const deflate of [true, false]) {
      const file = await write(
        'a.zip',
        makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'x'.repeat(1000) }, deflate),
      );
      expect((await listZip(file)).map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
      expect((await readZipEntry(file, 'dir/b.txt'))?.toString()).toBe('x'.repeat(1000));
      expect(await readZipEntry(file, 'missing')).toBeUndefined();
    }
  });

  it('rejects non-zip files and oversized entries', async () => {
    await expect(listZip(await write('x.zip', Buffer.from('not a zip')))).rejects.toThrow(
      /Not a zip/,
    );
    const big = await write('big.zip', makeZip({ 'big.txt': Buffer.alloc(2000) }));
    await expect(readZipEntry(big, 'big.txt', 1000)).rejects.toThrow(/too large/);
  });
});

describe('VSIX verification', () => {
  it('reads the manifest of a real vsce package', async () => {
    const file = path.join(await tempDir(), 'demo.vsix');
    await packageFixture(
      path.join(ROOT, 'test/fixtures/demo-extension'),
      { version: '1.2.3' },
      file,
    );
    expect(await readVsixManifest(file)).toMatchObject({
      id: 'leuchtturm-demo.hello',
      version: '1.2.3',
      displayName: 'Leuchtturm Demo Hello',
    });
    expect(await verifyVsix(file, 'Leuchtturm-Demo.Hello', '1.2.3')).toMatchObject({ ok: true });
  }, 30_000);

  it('rejects a different extension or version', async () => {
    const file = await write('x.vsix', makeVsix('corp', 'linter', '1.4.1'));
    await expect(verifyVsix(file, 'corp.other', '1.4.1')).rejects.toThrow(
      /contains corp\.linter 1\.4\.1, but corp\.other 1\.4\.1 was expected/,
    );
    await expect(verifyVsix(file, 'corp.linter', '1.4.0')).rejects.toThrow(/was expected/);
  });

  it('flags a different publisher for confirmation', async () => {
    const file = await write('x.vsix', makeVsix('impostor', 'linter', '1.4.1'));
    expect(await verifyVsix(file, 'corp.linter', '1.4.1')).toMatchObject({
      ok: false,
      publisherMismatch: true,
      manifest: { id: 'impostor.linter' },
    });
  });

  it('explains files that are not VSIX packages', async () => {
    await expect(readVsixManifest(await write('a.vsix', Buffer.from('nope')))).rejects.toThrow(
      /Not a valid \.vsix: Not a zip/,
    );
    await expect(
      readVsixManifest(await write('b.vsix', makeZip({ 'x.txt': 'x' }))),
    ).rejects.toThrow(/extension\/package\.json is missing/);
  });
});
