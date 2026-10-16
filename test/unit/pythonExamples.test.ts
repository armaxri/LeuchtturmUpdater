/**
 * Runs the Python examples from examples/script through ScriptSource, against local fake
 * servers. Skipped when no Python ≥ 3.8 is installed.
 */

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig, type ScriptSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import { ScriptSource } from '../../src/sources/scriptSource';
import { startFakeServer, type FakeServer } from '../../src/test/fakeServer';
import { ROOT } from '../../src/test/paths';
import { findPython } from '../../src/test/python';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import type { JsonSchema } from '../../src/util/jsonSchema';
import { settings, tempDir } from './helpers';

const python = findPython();
const schema = JSON.parse(
  readFileSync(path.join(ROOT, 'schemas/script-protocol.schema.json'), 'utf8'),
) as JsonSchema;

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function example(name: string, env: Record<string, string>) {
  const config = parseConfig(
    settings({
      'script.enabled': true,
      sources: {
        s: {
          type: 'script',
          command: python,
          script: path.join(ROOT, 'examples/script', name),
          env,
        },
      },
    }),
  );
  expect(config.problems).toEqual([]);
  return new ScriptSource(config.sources[0] as ScriptSourceConfig, 30_000, NULL_LOGGER, {
    gate: { enabled: () => true, isApproved: () => true, requestApproval: () => undefined },
    schema,
    hostVersion: '1.99.0',
  });
}

async function vsixDir(files: Record<string, string>): Promise<string> {
  const dir = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe.skipIf(!python)(`Python examples (${python ?? 'no python'})`, () => {
  it('minimal_static.py lists versions and returns download URLs', async () => {
    const dir = await vsixDir({ 'corp.hello-1.1.0.vsix': 'hello 1.1.0' });
    const s = await startFakeServer({ autoindex: { dir } });
    servers.push(s);
    const src = example('minimal_static.py', { ARTIFACT_HOST: `${s.url}/vsix` });
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(artifact).toMatchObject({ id: 'corp.hello', displayName: 'Corp Hello' });
    expect(artifact!.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    const file = await src.download(
      artifact!,
      artifact!.versions[0]!,
      await tempDir(),
      NEVER_CANCELLED,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('hello 1.1.0');
    // No notes action handler: exit code 3 = not supported.
    expect(
      await src.fetchReleaseNotes(artifact!, artifact!.versions[0]!, NEVER_CANCELLED),
    ).toBeUndefined();
  });

  it('folder_source.py returns local paths with sha256 and notes', async () => {
    const dir = await vsixDir({
      'corp.a-1.0.0.vsix': 'a1',
      'corp.a-1.0.0.md': '- notes for a',
      'corp.a-2.0.0-beta.1.vsix': 'a2',
      'readme.txt': 'ignored',
    });
    const src = example('folder_source.py', { VSIX_FOLDER: dir });
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(artifact!.versions.map((v) => [v.version, v.sha256?.length, v.releaseNotes])).toEqual([
      ['2.0.0-beta.1', 64, undefined],
      ['1.0.0', 64, '- notes for a'],
    ]);
    const target = await tempDir();
    const file = await src.download(artifact!, artifact!.versions[1]!, target, NEVER_CANCELLED);
    expect(path.dirname(file)).toBe(target);
    expect(await fs.readFile(file, 'utf8')).toBe('a1');

    const missing = example('folder_source.py', { VSIX_FOLDER: path.join(dir, 'nope') });
    await expect(missing.list(NEVER_CANCELLED)).rejects.toThrow(/^Folder not found/);
  });

  it('jenkins_source.py signs in itself (environment) and downloads the file itself', async () => {
    const dir = await vsixDir({
      'corp.ci-2.1.0.vsix': 'ci 2.1.0',
      'corp.ci-2.0.0.vsix': 'ci 2.0.0',
    });
    const s = await startFakeServer({
      auth: { user: 'reader', password: 'tok-123' },
      jenkins: {
        job: 'ci',
        builds: [
          {
            number: 9,
            result: 'SUCCESS',
            artifacts: { 'dist/corp.ci-2.1.0.vsix': path.join(dir, 'corp.ci-2.1.0.vsix') },
            changelog: '## 2.1.0',
          },
          { number: 8, result: 'FAILURE', artifacts: {} },
          {
            number: 7,
            result: 'SUCCESS',
            artifacts: { 'dist/corp.ci-2.0.0.vsix': path.join(dir, 'corp.ci-2.0.0.vsix') },
          },
        ],
      },
    });
    servers.push(s);
    const env = {
      JENKINS_URL: s.url,
      JENKINS_JOB: 'ci',
      JENKINS_USER: 'reader',
      JENKINS_TOKEN: 'tok-123',
    };
    const src = example('jenkins_source.py', env);
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(artifact!.versions.map((v) => [v.version, v.ref.build])).toEqual([
      ['2.1.0', '9'],
      ['2.0.0', '7'],
    ]);
    const file = await src.download(
      artifact!,
      artifact!.versions[1]!,
      await tempDir(),
      NEVER_CANCELLED,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('ci 2.0.0');
    expect(await src.fetchReleaseNotes(artifact!, artifact!.versions[0]!, NEVER_CANCELLED)).toBe(
      '## 2.1.0',
    );
    expect(
      await src.fetchReleaseNotes(artifact!, artifact!.versions[1]!, NEVER_CANCELLED),
    ).toBeUndefined();

    const wrong = example('jenkins_source.py', { ...env, JENKINS_TOKEN: 'wrong' });
    await expect(wrong.list(NEVER_CANCELLED)).rejects.toThrow(
      /HTTP 401 from Jenkins \(check JENKINS_USER\/JENKINS_TOKEN\)/,
    );
  });

  it('manifest_source.py reads a versions.json from a web server', async () => {
    const dir = await vsixDir({ 'corp.m-1.2.0.vsix': 'm 1.2.0' });
    await fs.writeFile(
      path.join(dir, 'versions.json'),
      JSON.stringify({
        artifacts: [
          {
            id: 'corp.m',
            displayName: 'Corp M',
            versions: [{ version: '1.2.0', url: 'corp.m-1.2.0.vsix', notes: '- m' }],
          },
        ],
      }),
    );
    const s = await startFakeServer({ autoindex: { dir } });
    servers.push(s);
    const src = example('manifest_source.py', { MANIFEST_URL: `${s.url}/vsix/versions.json` });
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(artifact).toMatchObject({
      id: 'corp.m',
      displayName: 'Corp M',
      versions: [{ version: '1.2.0', releaseNotes: '- m' }],
    });
    const file = await src.download(
      artifact!,
      artifact!.versions[0]!,
      await tempDir(),
      NEVER_CANCELLED,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('m 1.2.0');
  });
});
