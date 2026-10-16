import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Candidate } from '../../src/checker';
import { Installer } from '../../src/installer';
import { NULL_LOGGER } from '../../src/log';
import type { Artifact, Source } from '../../src/sources/types';
import type { Target } from '../../src/targets/types';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import { tempDir } from './helpers';

class FakeTarget implements Target {
  readonly kind = 'vscode-extension' as const;
  verify?: Target['verify'];
  installed: { path: string; content: string; id: string; version: string }[] = [];
  getInstalledVersion(): string | undefined {
    return undefined;
  }
  async install(downloadedPath: string, id: string, version: string): Promise<void> {
    // Read now: the installer deletes the download afterwards.
    this.installed.push({
      path: downloadedPath,
      content: await fs.readFile(downloadedPath, 'utf8'),
      id,
      version,
    });
  }
}

function setup(payload: string, sha256?: string) {
  const artifact: Artifact = {
    id: 'corp.linter',
    kind: 'vscode-extension',
    versions: [{ version: '1.4.1', sha256, ref: {} }],
  };
  const source: Source = {
    name: 'fake',
    type: 'file',
    list: async () => [artifact],
    download: async (_a, v, dir) => {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `corp.linter-${v.version}.vsix`);
      await fs.writeFile(file, payload);
      return file;
    },
  };
  const candidate: Candidate = {
    version: '1.4.1',
    sourceName: 'fake',
    sourceType: 'file',
    artifact,
    available: artifact.versions[0]!,
  };
  return { source, candidate };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Installer', () => {
  it('downloads, verifies, installs and cleans up', async () => {
    const downloads = await tempDir();
    const target = new FakeTarget();
    const { source, candidate } = setup('vsix-bytes', sha('vsix-bytes').toUpperCase());
    await new Installer(downloads, target, NULL_LOGGER).install(source, candidate, NEVER_CANCELLED);
    expect(target.installed).toMatchObject([
      { content: 'vsix-bytes', id: 'corp.linter', version: '1.4.1' },
    ]);
    expect(target.installed[0]!.path.startsWith(downloads)).toBe(true);
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it('refuses to install on a SHA-256 mismatch', async () => {
    const downloads = await tempDir();
    const target = new FakeTarget();
    const { source, candidate } = setup('tampered', sha('original'));
    await expect(
      new Installer(downloads, target, NULL_LOGGER).install(source, candidate, NEVER_CANCELLED),
    ).rejects.toThrow(/SHA-256 mismatch/);
    expect(target.installed).toEqual([]);
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it('does not install the same artifact twice at once', async () => {
    const downloads = await tempDir();
    const target = new FakeTarget();
    const { source, candidate } = setup('x');
    const installer = new Installer(downloads, target, NULL_LOGGER);
    const first = installer.install(source, candidate, NEVER_CANCELLED);
    await expect(installer.install(source, candidate, NEVER_CANCELLED)).rejects.toThrow(
      /already being installed/,
    );
    await first;
    expect(target.installed).toHaveLength(1);
  });

  it('respects the cross-window install lock and releases it afterwards', async () => {
    const downloads = await tempDir();
    const target = new FakeTarget();
    const { source, candidate } = setup('x');
    const held = new Set<string>(['corp.linter']);
    const released: string[] = [];
    const installer = new Installer(downloads, target, NULL_LOGGER, {
      acquire: async (id) => !held.has(id),
      release: async (id) => void released.push(id),
    });
    await expect(installer.install(source, candidate, NEVER_CANCELLED)).rejects.toThrow(
      /another window/,
    );
    expect(released).toEqual([]);
    held.clear();
    await installer.install(source, candidate, NEVER_CANCELLED);
    expect(released).toEqual(['corp.linter']);
    expect(target.installed).toHaveLength(1);
  });

  it('asks before installing a VSIX from another publisher, and stops if declined', async () => {
    for (const answer of [false, true]) {
      const target = new FakeTarget();
      target.verify = async () => ({ confirm: 'published by someone else' });
      const questions: string[] = [];
      const { source, candidate } = setup('x');
      const installer = new Installer(
        await tempDir(),
        target,
        NULL_LOGGER,
        undefined,
        async (q) => {
          questions.push(q);
          return answer;
        },
      );
      const result = installer.install(source, candidate, NEVER_CANCELLED);
      if (answer) {
        await result;
        expect(target.installed).toHaveLength(1);
      } else {
        await expect(result).rejects.toThrow(/publisher .* does not match/);
        expect(target.installed).toEqual([]);
      }
      expect(questions).toEqual(['published by someone else']);
    }
  });

  it('never installs what verification rejects', async () => {
    const target = new FakeTarget();
    target.verify = async () => {
      throw new Error('contains corp.other');
    };
    const { source, candidate } = setup('x');
    await expect(
      new Installer(await tempDir(), target, NULL_LOGGER).install(
        source,
        candidate,
        NEVER_CANCELLED,
      ),
    ).rejects.toThrow(/corp.other/);
    expect(target.installed).toEqual([]);
  });
});
