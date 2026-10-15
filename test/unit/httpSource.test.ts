import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig, type HttpSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import { HttpSource } from '../../src/sources/httpSource';
import { startFakeServer, type FakeServer } from '../../src/test/fakeServer';
import { TLS_CERT } from '../../src/test/paths';
import { NEVER_CANCELLED } from '../../src/util/cancellation';
import { settings, tempDir } from './helpers';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function jenkins(): Promise<FakeServer> {
  const dir = await tempDir();
  const file = async (name: string) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, `content of ${name}`);
    return p;
  };
  const s = await startFakeServer({
    auth: { user: 'ci', password: 'hunter22' },
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

function source(raw: Record<string, unknown>, secrets: Record<string, string> = {}): HttpSource {
  const config = parseConfig(settings({ sources: { jenkins: { type: 'http', ...raw } } }), {
    secrets,
  });
  expect(config.problems).toEqual([]);
  return new HttpSource(config.sources[0] as HttpSourceConfig, 5000, NULL_LOGGER);
}

function jenkinsConfig(url: string) {
  return {
    index: {
      url: `${url}/job/linter/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]`,
    },
    auth: { basic: { user: 'ci', password: '${secret:jenkins}' } },
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
  it('lists versions, downloads with auth and fetches release notes', async () => {
    const s = await jenkins();
    const src = source(jenkinsConfig(s.url), { jenkins: 'hunter22' });
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
    expect(s.requests.every((r) => r.endsWith('auth=yes'))).toBe(true);
  });

  it('reports wrong credentials clearly', async () => {
    const s = await jenkins();
    const src = source(jenkinsConfig(s.url), { jenkins: 'wrong' });
    await expect(src.list(NEVER_CANCELLED)).rejects.toThrow(/HTTP 401.*check credentials/);
  });

  it('reads a web server directory listing over HTTPS with a custom CA', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'corp.web-0.3.0.vsix'), 'web');
    await fs.writeFile(path.join(dir, 'README.txt'), 'ignore me');
    const s = await startFakeServer({ tls: true, autoindex: { dir } });
    servers.push(s);
    const raw = {
      index: { url: `${s.url}/vsix/` },
      match: {
        regex: 'href="(?<file>(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix)"',
      },
      download: { url: `${s.url}/vsix/\${file}` },
    };
    await expect(source(raw).list(NEVER_CANCELLED)).rejects.toThrow(/self[- ]signed/i);

    const withCa = source({ ...raw, ca: TLS_CERT });
    const [artifact] = await withCa.list(NEVER_CANCELLED);
    expect(artifact).toMatchObject({ id: 'corp.web', versions: [{ version: '0.3.0' }] });
    const file = await withCa.download(
      artifact!,
      artifact!.versions[0]!,
      await tempDir(),
      NEVER_CANCELLED,
    );
    expect(await fs.readFile(file, 'utf8')).toBe('web');

    const insecure = source({ ...raw, strictSSL: false });
    expect(insecure.warnings).toEqual([expect.stringMatching(/verification is disabled/)]);
    expect(await insecure.list(NEVER_CANCELLED)).toHaveLength(1);
  });

  it('fails clearly for a missing CA file', async () => {
    const src = source({
      index: { url: 'https://127.0.0.1:1/' },
      match: { regex: '(?<id>a\\.b)-(?<version>.+)' },
      download: { url: 'https://127.0.0.1:1/${id}' },
      ca: '/does/not/exist.pem',
    });
    await expect(src.list(NEVER_CANCELLED)).rejects.toThrow(/Cannot read CA certificate/);
  });
});
