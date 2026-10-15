import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_FILE_PATTERN, type FileSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import { FileSource } from '../../src/sources/fileSource';
import { CancellationSource, NEVER_CANCELLED } from '../../src/util/cancellation';
import { tempDir, writeFiles } from './helpers';

function source(dir: string, extra: Partial<FileSourceConfig> = {}): FileSource {
  return new FileSource(
    {
      name: 'share',
      type: 'file',
      path: dir,
      recursive: false,
      filePattern: new RegExp(DEFAULT_FILE_PATTERN, 'i'),
      include: [],
      exclude: [],
      ...extra,
    },
    NULL_LOGGER,
  );
}

describe('FileSource.list', () => {
  it('finds VSIX files in all supported layouts', async () => {
    const dir = await tempDir();
    await writeFiles(dir, {
      'corp.linter-1.3.0.vsix': 'a',
      'corp.linter-1.4.1.vsix': 'b',
      'corp/corp.snippets-1.0.0.vsix': 'c',
      'corp.theme/corp.theme-2.1.0.vsix': 'd',
      'corp.my-ext-0.1.0-beta.1.vsix': 'e',
      'unrelated/corp.ignored-1.0.0.vsix': 'f', // folder matches neither publisher nor id
      'deep/er/corp.deep-1.0.0.vsix': 'g', // too deep for a non-recursive scan
      'not-a-vsix.txt': 'h',
      'corp.badversion-1.0.vsix': 'i',
    });
    const artifacts = await source(dir).list(NEVER_CANCELLED);
    const summary = Object.fromEntries(
      artifacts.map((a) => [a.id, a.versions.map((v) => v.version)]),
    );
    expect(summary).toEqual({
      'corp.linter': ['1.4.1', '1.3.0'],
      'corp.snippets': ['1.0.0'],
      'corp.theme': ['2.1.0'],
      'corp.my-ext': ['0.1.0-beta.1'],
    });
    expect(artifacts.every((a) => a.kind === 'vscode-extension')).toBe(true);
    const linter = artifacts.find((a) => a.id === 'corp.linter')!;
    expect(linter.versions[0]!.ref.path).toBe(path.join(dir, 'corp.linter-1.4.1.vsix'));
  });

  it('scans every depth when recursive', async () => {
    const dir = await tempDir();
    await writeFiles(dir, {
      'deep/er/corp.deep-1.0.0.vsix': 'g',
      'unrelated/corp.other-2.0.0.vsix': 'f',
    });
    const ids = (await source(dir, { recursive: true }).list(NEVER_CANCELLED)).map((a) => a.id);
    expect(ids.sort()).toEqual(['corp.deep', 'corp.other']);
  });

  it('reads sha256 and release-note sidecars', async () => {
    const dir = await tempDir();
    const hash = 'A'.repeat(64);
    await writeFiles(dir, {
      'corp.linter-1.4.1.vsix': 'x',
      'corp.linter-1.4.1.vsix.sha256': `${hash}  corp.linter-1.4.1.vsix\n`,
      'corp.linter-1.4.1.md': '- Fix crash',
      'corp.linter-1.4.0.vsix': 'y',
      'corp.linter-1.4.0.vsix.sha256': 'not a hash',
      'corp.linter-1.4.0.vsix.md': 'notes 1.4.0',
    });
    const [linter] = await source(dir).list(NEVER_CANCELLED);
    expect(linter!.versions[0]).toMatchObject({
      version: '1.4.1',
      sha256: 'a'.repeat(64),
      releaseNotes: '- Fix crash',
    });
    expect(linter!.versions[1]).toMatchObject({ version: '1.4.0', releaseNotes: 'notes 1.4.0' });
    expect(linter!.versions[1]!.sha256).toBeUndefined();
  });

  it('honours a custom filePattern', async () => {
    const dir = await tempDir();
    await writeFiles(dir, { 'linter_v1.2.3.vsix': 'x' });
    const src = source(dir, {
      filePattern: /^(?<id>linter)_v(?<version>\d+\.\d+\.\d+)\.vsix$/i,
    });
    const [a] = await src.list(NEVER_CANCELLED);
    expect(a).toMatchObject({ id: 'linter', versions: [{ version: '1.2.3' }] });
  });

  it('fails clearly for a missing folder', async () => {
    const dir = await tempDir();
    await expect(source(path.join(dir, 'missing')).list(NEVER_CANCELLED)).rejects.toThrow(
      /Folder not found/,
    );
  });

  it('stops when cancelled', async () => {
    const dir = await tempDir();
    const cts = new CancellationSource();
    cts.cancel();
    await expect(source(dir).list(cts.token)).rejects.toThrow(/Cancelled/);
  });
});

describe('FileSource.download', () => {
  it('copies the file into the target directory', async () => {
    const dir = await tempDir();
    const target = await tempDir();
    await writeFiles(dir, { 'corp.linter-1.4.1.vsix': 'payload' });
    const src = source(dir);
    const [artifact] = await src.list(NEVER_CANCELLED);
    const file = await src.download(
      artifact!,
      artifact!.versions[0]!,
      path.join(target, 'sub'),
      NEVER_CANCELLED,
    );
    expect(file).toBe(path.join(target, 'sub', 'corp.linter-1.4.1.vsix'));
    expect(await fs.readFile(file, 'utf8')).toBe('payload');
  });
});

describe('FileSource reporting', () => {
  it('explains every decision for Test Source', async () => {
    const dir = await tempDir();
    await writeFiles(dir, {
      'corp.linter-1.4.1.vsix': 'x',
      'random.vsix': 'x',
      'other/corp.x-1.0.0.vsix': 'x',
      'corp/deeper/corp.y-1.0.0.vsix': 'x',
    });
    const lines: string[] = [];
    await source(dir).list(NEVER_CANCELLED, (l) => lines.push(l));
    const text = lines.join('\n');
    expect(text).toContain('matched  corp.linter-1.4.1.vsix → corp.linter 1.4.1');
    expect(text).toContain('skipped  random.vsix: does not match the file pattern');
    expect(text).toMatch(/skipped {2}other.corp\.x-1\.0\.0\.vsix: folder "other" is neither/);
    expect(text).toContain('not scanned: sub-folders of corp');
  });
});
