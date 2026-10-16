/**
 * "Paste a link": from a Jenkins page, a web page, a folder or an npm name to a working source.
 * Runs against the fake Jenkins and web server, real folders and the real source code, the
 * same way the editor does.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import {
  analyseFileNames,
  discover,
  jenkinsJobUrl,
  looksLikePath,
  suggestName,
} from '../../src/sourceEditor/discover';
import type { Discovery } from '../../src/sourceEditor/protocol';
import type { RawSource } from '../../src/sourceEditor/values';
import { createSource } from '../../src/sources';
import { startFakeServer, type FakeBuild, type FakeServer } from '../../src/test/fakeServer';
import { makeVsix } from '../../src/test/zip';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import { settings, tempDir } from './helpers';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Lists a candidate source with the real implementation, like `Controller.listDraft`. */
async function list(name: string, raw: RawSource) {
  const config = parseConfig(settings({ sources: { [name]: raw } }));
  const parsed = config.sources[0];
  if (!parsed) {
    throw new Error(config.problems[0]?.message);
  }
  const source = createSource(parsed, NULL_LOGGER, {
    timeoutMs: 10_000,
    script: {
      gate: { enabled: () => false, isApproved: () => false, requestApproval: () => undefined },
      schema: {},
      hostVersion: '1.99.0',
    },
  });
  return source.list(NEVER_CANCELLED);
}

const look = (input: string) => discover(input, { list, timeoutMs: 10_000 });

/** Writes real .vsix files (with a manifest) and returns their paths by file name. */
async function vsixFiles(files: Record<string, [string, string, string]>) {
  const dir = await tempDir();
  const out: Record<string, string> = {};
  for (const [file, [publisher, name, version]] of Object.entries(files)) {
    out[file] = path.join(dir, file);
    await fs.writeFile(out[file], makeVsix(publisher, name, version));
  }
  return out;
}

async function jenkins(builds: FakeBuild[], login = false): Promise<FakeServer> {
  const s = await startFakeServer({
    ...(login ? { auth: { user: 'u', password: 'p' } } : {}),
    jenkins: { job: 'corp-linter', builds },
  });
  servers.push(s);
  return s;
}

function expectFound(result: Discovery): Extract<Discovery, { kind: 'found' }> {
  if (result.kind !== 'found') {
    throw new Error(`expected "found", got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('discover: Jenkins', () => {
  async function standardJob() {
    const v = await vsixFiles({
      'corp.linter-1.4.1.vsix': ['corp', 'linter', '1.4.1'],
      'corp.linter-1.4.0.vsix': ['corp', 'linter', '1.4.0'],
    });
    return jenkins([
      {
        number: 12,
        result: 'SUCCESS',
        artifacts: { 'dist/corp.linter-1.4.1.vsix': v['corp.linter-1.4.1.vsix']! },
      },
      { number: 11, result: 'FAILURE', artifacts: {} },
      {
        number: 10,
        result: 'SUCCESS',
        artifacts: { 'dist/corp.linter-1.4.0.vsix': v['corp.linter-1.4.0.vsix']! },
      },
    ]);
  }

  it.each([
    ['the job page', '/job/corp-linter/'],
    ['"Last Successful Artifacts"', '/job/corp-linter/lastSuccessfulBuild/artifact/'],
    [
      'one artifact link',
      '/job/corp-linter/lastSuccessfulBuild/artifact/dist/corp.linter-1.4.1.vsix',
    ],
    ['a build page', '/job/corp-linter/12/'],
  ])('turns %s into a source over the job’s recent builds', async (_what, suffix) => {
    const s = await standardJob();
    const result = expectFound(await look(`${s.url}${suffix}`));
    expect(result.what).toBe('Jenkins job "corp-linter"');
    expect(result.name).toBe('corp-linter');
    expect(result.extensions).toEqual([{ id: 'corp.linter', versions: ['1.4.1', '1.4.0'] }]);
    expect(result.source).toEqual({
      type: 'http',
      index: {
        url: `${s.url}/job/corp-linter/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,20}`,
      },
      match: {
        jsonPath: '$.builds[*].artifacts[*]',
        where: { result: 'SUCCESS' },
        field: 'fileName',
        regex: expect.any(String),
      },
      download: { url: `${s.url}/job/corp-linter/\${number}/artifact/\${relativePath}` },
    });
    expect(result.notes[0]).toMatch(/last 20 builds .* older versions can be installed/);
  });

  it('reads the extension ID from inside the .vsix when file names have no publisher', async () => {
    const v = await vsixFiles({
      'linter-2.0.0.vsix': ['corp', 'linter', '2.0.0'],
      'linter-1.9.0.vsix': ['corp', 'linter', '1.9.0'],
    });
    const s = await jenkins([
      { number: 3, result: 'SUCCESS', artifacts: { 'linter-2.0.0.vsix': v['linter-2.0.0.vsix']! } },
      { number: 2, result: 'SUCCESS', artifacts: { 'linter-1.9.0.vsix': v['linter-1.9.0.vsix']! } },
    ]);
    const result = expectFound(await look(`${s.url}/job/corp-linter/`));
    expect(result.source.match).toMatchObject({ id: 'corp.linter' });
    expect(result.extensions).toEqual([{ id: 'corp.linter', versions: ['2.0.0', '1.9.0'] }]);
    expect(result.notes.join(' ')).toMatch(/extension ID corp\.linter was read from inside/);
  });

  it('explains file names without a version', async () => {
    const v = await vsixFiles({ 'linter.vsix': ['corp', 'linter', '2.0.0'] });
    const s = await jenkins([
      { number: 3, result: 'SUCCESS', artifacts: { 'out/linter.vsix': v['linter.vsix']! } },
    ]);
    const result = await look(`${s.url}/job/corp-linter/`);
    expect(result).toMatchObject({ kind: 'problem' });
    expect(result.kind === 'problem' && result.message).toMatch(
      /"linter\.vsix" contains no version number.*publisher\.name-1\.2\.3\.vsix/,
    );
  });

  it('explains a job that archives no .vsix', async () => {
    const s = await jenkins([{ number: 1, result: 'SUCCESS', artifacts: {} }]);
    const result = await look(`${s.url}/job/corp-linter/`);
    expect(result.kind === 'problem' && result.hints[0]).toMatch(/Archive the \.vsix/);
  });

  it('points to script sources when Jenkins needs a login', async () => {
    const s = await jenkins([], true);
    const result = await look(`${s.url}/job/corp-linter/lastSuccessfulBuild/artifact/`);
    expect(result).toMatchObject({ kind: 'login', what: 'Jenkins job "corp-linter"' });
    expect(result.kind === 'login' && result.message).toMatch(
      /does not handle logins.*"script" source/,
    );
  });
});

describe('discover: web page', () => {
  async function listing() {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'corp.web-0.3.0.vsix'), makeVsix('corp', 'web', '0.3.0'));
    await fs.writeFile(path.join(dir, 'corp.web-0.2.0.vsix'), makeVsix('corp', 'web', '0.2.0'));
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
    const s = await startFakeServer({ autoindex: { dir } });
    servers.push(s);
    return s;
  }

  it('turns a page with .vsix links into a source whose downloads work', async () => {
    const s = await listing();
    const result = expectFound(await look(`${s.url}/vsix/`));
    expect(result.extensions).toEqual([{ id: 'corp.web', versions: ['0.3.0', '0.2.0'] }]);
    expect(result.source).toMatchObject({
      type: 'http',
      index: { url: `${s.url}/vsix/` },
      download: { url: `${s.url}/vsix/\${file}` },
    });
    expect(result.name).toBe('vsix');
  });

  it('uses the page a pasted .vsix link is on', async () => {
    const s = await listing();
    const result = expectFound(await look(`${s.url}/vsix/corp.web-0.3.0.vsix`));
    expect(result.source).toMatchObject({ index: { url: `${s.url}/vsix/` } });
  });

  it('explains a page without .vsix links', async () => {
    const s = await startFakeServer({});
    servers.push(s);
    const result = await look(`${s.url}/redirect?to=/nothing`);
    expect(result.kind).toBe('problem');
  });
});

describe('discover: folder', () => {
  it('finds .vsix files directly in a folder, or in its sub-folders', async () => {
    const flat = await tempDir();
    await fs.writeFile(path.join(flat, 'corp.a-1.0.0.vsix'), 'x');
    expect(expectFound(await look(flat)).source).toEqual({ type: 'file', path: flat });

    const nested = await tempDir();
    // Two levels deep: one level (a publisher folder) is found without `recursive`.
    await fs.mkdir(path.join(nested, 'releases', '2026'), { recursive: true });
    await fs.writeFile(path.join(nested, 'releases', '2026', 'corp.b-2.0.0.vsix'), 'x');
    const deep = expectFound(await look(nested));
    expect(deep.source).toEqual({ type: 'file', path: nested, recursive: true });
    expect(deep.extensions).toEqual([{ id: 'corp.b', versions: ['2.0.0'] }]);
  });

  it('explains an empty or missing folder', async () => {
    const empty = await tempDir();
    expect(await look(empty)).toMatchObject({
      kind: 'problem',
      message: expect.stringMatching(/No \.vsix files/),
    });
    expect(await look(path.join(empty, 'nope'))).toMatchObject({
      kind: 'problem',
      message: expect.stringMatching(/does not exist/),
    });
  });
});

describe('discover: input', () => {
  it('rejects text that is neither a link, a folder nor an npm name', async () => {
    expect(await look('not a link at all')).toMatchObject({ kind: 'problem' });
    expect(await look('   ')).toMatchObject({ kind: 'problem' });
  });

  it('recognises paths on every platform', () => {
    for (const p of ['/Volumes/x', '~/vsix', '\\\\server\\share', 'C:\\vsix', 'file:///x']) {
      expect(looksLikePath(p)).toBe(true);
    }
    expect(looksLikePath('@corp/linter')).toBe(false);
  });

  it('finds the Jenkins job in any Jenkins link, including folders', () => {
    const job = (u: string) => jenkinsJobUrl(new URL(u))?.href;
    expect(job('https://ci.example/job/team/job/linter/lastSuccessfulBuild/artifact/x.vsix')).toBe(
      'https://ci.example/job/team/job/linter/',
    );
    expect(job('https://ci.example/jenkins/job/linter/42/')).toBe(
      'https://ci.example/jenkins/job/linter/',
    );
    expect(job('https://files.example/vsix/')).toBeUndefined();
  });

  it('analyses file names', () => {
    expect(analyseFileNames(['corp.a-1.0.0.vsix', 'corp.b-2.0.0-beta.1.vsix'])).toMatchObject({
      kind: 'vsce',
    });
    const versioned = analyseFileNames(['my-tool-1.0.0.vsix', 'my-tool-1.1.0.vsix']);
    expect(versioned).toMatchObject({ kind: 'versioned', base: 'my-tool' });
    expect(
      versioned.kind === 'versioned' &&
        new RegExp(versioned.regex).exec('my-tool-1.1.0.vsix')?.groups?.version,
    ).toBe('1.1.0');
    expect(analyseFileNames(['a-1.0.0.vsix', 'b-1.0.0.vsix']).kind).toBe('unusable');
    expect(analyseFileNames(['tool.vsix']).kind).toBe('unusable');
  });

  it('suggests source names', () => {
    expect(suggestName('Corp Linter (nightly)')).toBe('corp-linter-nightly');
    expect(suggestName('...')).toBe('source');
  });
});
