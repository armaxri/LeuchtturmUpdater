import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig, type HttpSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import { HttpSource } from '../../src/sources/httpSource';
import { startFakeServer, type FakeServer } from '../../src/test/fakeServer';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import { settings, tempDir } from './helpers';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function jenkins(login = false): Promise<FakeServer> {
  const dir = await tempDir();
  const file = async (name: string) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, `content of ${name}`);
    return p;
  };
  const s = await startFakeServer({
    ...(login ? { auth: { user: 'ci', password: 'hunter22' } } : {}),
    jenkins: {
      job: 'linter',
      builds: [
        {
          number: 42,
          result: 'SUCCESS',
          artifacts: { 'out/corp.linter-1.4.1.vsix': await file('corp.linter-1.4.1.vsix') },
          changelog: '## 1.4.1\n- Fix',
        },
        {
          number: 41,
          result: 'SUCCESS',
          artifacts: { 'out/corp.linter-1.4.0.vsix': await file('corp.linter-1.4.0.vsix') },
        },
        // Rebuilt version: the newer build (first in the index) must win.
        {
          number: 40,
          result: 'SUCCESS',
          artifacts: { 'out/corp.linter-1.4.0.vsix': await file('old.vsix') },
        },
        { number: 39, result: 'FAILURE', artifacts: {} },
      ],
    },
  });
  servers.push(s);
  return s;
}

function source(raw: Record<string, unknown>): HttpSource {
  const config = parseConfig(settings({ sources: { jenkins: { type: 'http', ...raw } } }));
  expect(config.problems).toEqual([]);
  return new HttpSource(config.sources[0] as HttpSourceConfig, 5000, NULL_LOGGER);
}

function jenkinsConfig(url: string) {
  return {
    index: {
      url: `${url}/job/linter/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]`,
    },
    match: {
      jsonPath: '$.builds[*].artifacts[*]',
      where: { result: 'SUCCESS' },
      field: 'fileName',
      regex: '^(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix$',
    },
    download: { url: `${url}/job/linter/\${number}/artifact/\${relativePath}` },
    releaseNotes: { url: `${url}/job/linter/\${number}/artifact/CHANGELOG.md` },
  };
}

describe('HttpSource (fake Jenkins)', () => {
  it('lists versions, downloads and fetches release notes', async () => {
    const s = await jenkins();
    const src = source(jenkinsConfig(s.url));
    const lines: string[] = [];
    const [artifact, ...rest] = await src.list(NEVER_CANCELLED, (l) => lines.push(l));
    expect(rest).toEqual([]);
    expect(artifact!.id).toBe('corp.linter');
    expect(artifact!.versions.map((v) => [v.version, v.ref.number])).toEqual([
      ['1.4.1', '42'],
      ['1.4.0', '41'],
    ]);
    expect(artifact!.versions[0]!.releaseNotesUrl).toBe(
      `${s.url}/job/linter/42/artifact/CHANGELOG.md`,
    );

    const report = lines.join('\n');
    expect(report).toContain('→ HTTP 200 OK');
    expect(report).toContain('"builds"');
    expect(report).toContain(`download ${s.url}/job/linter/42/artifact/out/corp.linter-1.4.1.vsix`);
    expect(report).toContain('duplicate corp.linter 1.4.0, ignored');

    const dir = await tempDir();
    const file = await src.download(artifact!, artifact!.versions[1]!, dir, NEVER_CANCELLED);
    expect(path.basename(file)).toBe('corp.linter-1.4.0.vsix');
    expect(await fs.readFile(file, 'utf8')).toBe('content of corp.linter-1.4.0.vsix');

    const notes = await src.fetchReleaseNotes(artifact!, artifact!.versions[0]!, NEVER_CANCELLED);
    expect(notes).toBe('## 1.4.1\n- Fix');
    // Leuchtturm never sends credentials.
    expect(s.requests.every((r) => r.endsWith('auth=no'))).toBe(true);
  });

  it('points to script sources when a server needs a login', async () => {
    const s = await jenkins(true);
    await expect(source(jenkinsConfig(s.url)).list(NEVER_CANCELLED)).rejects.toThrow(
      /HTTP 401.*needs a login\. Leuchtturm does not handle logins; use a script source/,
    );
  });

  it('reads a web server directory listing', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'corp.web-0.3.0.vsix'), 'web');
    await fs.writeFile(path.join(dir, 'README.txt'), 'ignore me');
    const s = await startFakeServer({ autoindex: { dir } });
    servers.push(s);
    const src = source({
      index: { url: `${s.url}/vsix/` },
      match: {
        regex: 'href="(?<file>(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix)"',
      },
      download: { url: `${s.url}/vsix/\${file}` },
    });
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(artifact).toMatchObject({ id: 'corp.web', versions: [{ version: '0.3.0' }] });
    const file = await src.download(
      artifact!,
      artifact!.versions[0]!,
      await tempDir(),
      NEVER_CANCELLED,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('web');
  });
});
