import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startFakeServer, type FakeServer } from '../../src/test/fakeServer';
import { TLS_CERT } from '../../src/test/paths';
import { CancellationSource, NEVER_CANCELLED } from '../../src/util/cancellation';
import { basicAuth, httpDownload, httpRequest, HttpError } from '../../src/util/http';
import { tempDir } from './helpers';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function fake(config: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const s = await startFakeServer(config);
  servers.push(s);
  return s;
}

/** A raw server for edge cases the fake Jenkins does not cover. */
async function raw(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const opts = { timeoutMs: 5000, token: NEVER_CANCELLED };

describe('httpRequest', () => {
  it('returns the body and explains auth failures', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'a.vsix'), 'x');
    const s = await fake({
      autoindex: { dir },
      auth: { user: 'u', password: 'p' },
      jenkins: { job: 'j', builds: [] },
    });
    const res = await httpRequest(`${s.url}/vsix/`, opts);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('href="a.vsix"');

    const err = await httpRequest(`${s.url}/job/j/api/json`, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/HTTP 401 Unauthorized — check credentials/);

    const ok = await httpRequest(`${s.url}/job/j/api/json`, {
      ...opts,
      headers: { authorization: basicAuth('u', 'p') },
    });
    expect(JSON.parse(ok.body.toString())).toEqual({ builds: [] });
  });

  it('follows redirects and drops credentials on a different origin', async () => {
    const other = await raw((req, res) => {
      res.end(`auth=${req.headers.authorization ?? 'none'}`);
    });
    const s = await fake({});
    const same = await raw((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' }).end();
      } else if (req.url === '/away') {
        res.writeHead(307, { location: `${other}/x` }).end();
      } else {
        res.end(`auth=${req.headers.authorization ?? 'none'}`);
      }
    });
    const headers = { authorization: 'Bearer secret' };
    expect((await httpRequest(`${same}/start`, { ...opts, headers })).body.toString()).toBe(
      'auth=Bearer secret',
    );
    const away = await httpRequest(`${same}/away`, { ...opts, headers });
    expect(away.body.toString()).toBe('auth=none');
    expect(away.url).toBe(`${other}/x`);
    await expect(httpRequest(`${s.url}/redirect?to=/nothing`, opts)).rejects.toThrow(/HTTP 404/);
  });

  it('times out and can be cancelled', async () => {
    const url = await raw(() => undefined); // never answers
    await expect(httpRequest(url, { ...opts, timeoutMs: 50 })).rejects.toThrow(/timed out/);
    const cts = new CancellationSource();
    const pending = httpRequest(url, { ...opts, token: cts.token });
    cts.cancel();
    await expect(pending).rejects.toThrow(/Cancelled/);
  });

  it('verifies TLS certificates unless told otherwise', async () => {
    const s = await fake({ tls: true, autoindex: { dir: await tempDir() } });
    await expect(httpRequest(`${s.url}/vsix/`, opts)).rejects.toThrow(/self[- ]signed/i);
    const insecure = await httpRequest(`${s.url}/vsix/`, { ...opts, strictSSL: false });
    expect(insecure.status).toBe(200);
    const withCa = await httpRequest(`${s.url}/vsix/`, {
      ...opts,
      ca: await fs.readFile(TLS_CERT),
    });
    expect(withCa.status).toBe(200);
  });

  it('limits the body size', async () => {
    const url = await raw((_req, res) => res.end('x'.repeat(2000)));
    await expect(httpRequest(url, { ...opts, maxBytes: 1000 })).rejects.toThrow(/larger than/);
  });
});

describe('httpDownload', () => {
  it('streams to a file and removes partial files on errors', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'a.vsix'), 'payload');
    const s = await fake({ autoindex: { dir } });
    const dest = path.join(await tempDir(), 'out.vsix');
    const res = await httpDownload(`${s.url}/vsix/a.vsix`, dest, opts);
    expect(res.bytes).toBe(7);
    expect(await fs.readFile(dest, 'utf8')).toBe('payload');

    const missing = path.join(await tempDir(), 'missing.vsix');
    await expect(httpDownload(`${s.url}/vsix/nope.vsix`, missing, opts)).rejects.toThrow(
      /HTTP 404/,
    );
    await expect(fs.stat(missing)).rejects.toThrow();
  });
});
