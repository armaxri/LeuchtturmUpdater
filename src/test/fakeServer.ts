/**
 * A local stand-in for a Jenkins server and a web server directory listing, used by the unit
 * tests, the integration tests and the sandbox. Never talk to real servers in tests.
 *
 *   /job/<job>/api/json                    Jenkins JSON API (builds newest first)
 *   /job/<job>/<n>/artifact/<path>         build artifacts
 *   /vsix/                                 nginx-style autoindex HTML of `autoindex.dir`
 *   /vsix/<file>                           files from that folder
 *   /redirect?to=<path>                    302 to another path (redirect tests)
 *
 * With `auth`, every /job/ request needs HTTP basic auth.
 */

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import { TLS_CERT, TLS_KEY } from './paths';

export interface FakeBuild {
  number: number;
  result: 'SUCCESS' | 'FAILURE' | 'UNSTABLE';
  /** Artifact relative path → local file. */
  artifacts: Record<string, string>;
  /** Text served as artifact `CHANGELOG.md`. */
  changelog?: string;
}

export interface FakeServerConfig {
  tls?: boolean;
  auth?: { user: string; password: string };
  jenkins?: { job: string; builds: FakeBuild[] };
  autoindex?: { dir: string };
}

export interface FakeServer {
  url: string;
  /** `METHOD path auth=yes|no` for every request, for assertions. */
  requests: string[];
  close(): Promise<void>;
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  type = 'text/plain',
) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function sendFile(res: http.ServerResponse, file: string | undefined): Promise<void> {
  if (!file) {
    send(res, 404, 'Not found');
    return;
  }
  try {
    send(res, 200, await fs.readFile(file), 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found');
  }
}

async function handle(
  config: FakeServerConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/redirect') {
    res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
    res.end();
    return;
  }

  const job = config.jenkins;
  if (job && p.startsWith(`/job/${job.job}/`)) {
    if (config.auth) {
      const expected = `Basic ${Buffer.from(`${config.auth.user}:${config.auth.password}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Jenkins"' });
        res.end('Unauthorized');
        return;
      }
    }
    const rest = p.slice(`/job/${job.job}/`.length);
    if (rest === 'api/json') {
      // Compact JSON, newest build first, like Jenkins.
      const builds = [...job.builds]
        .sort((a, b) => b.number - a.number)
        .map((b) => ({
          number: b.number,
          result: b.result,
          artifacts: Object.keys(b.artifacts).map((relativePath) => ({
            fileName: path.posix.basename(relativePath),
            relativePath,
          })),
        }));
      send(res, 200, JSON.stringify({ builds }), 'application/json');
      return;
    }
    const m = /^(\d+)\/artifact\/(.+)$/.exec(rest);
    const build = m && job.builds.find((b) => b.number === Number(m[1]));
    if (build && m[2] === 'CHANGELOG.md' && build.changelog !== undefined) {
      send(res, 200, build.changelog, 'text/markdown');
      return;
    }
    await sendFile(res, build ? build.artifacts[m[2]!] : undefined);
    return;
  }

  const index = config.autoindex;
  if (index && p.startsWith('/vsix/')) {
    const name = p.slice('/vsix/'.length);
    if (name === '') {
      const files = (await fs.readdir(index.dir)).sort();
      const links = files.map((f) => `<a href="${f}">${f}</a>  01-Jan-2026 00:00  1234`).join('\n');
      send(
        res,
        200,
        `<html><head><title>Index of /vsix/</title></head><body><h1>Index of /vsix/</h1><hr><pre><a href="../">../</a>\n${links}\n</pre><hr></body></html>`,
        'text/html',
      );
      return;
    }
    if (name.includes('/') || name.includes('..')) {
      send(res, 404, 'Not found');
      return;
    }
    await sendFile(res, path.join(index.dir, name));
    return;
  }
  send(res, 404, 'Not found');
}

export async function startFakeServer(config: FakeServerConfig): Promise<FakeServer> {
  const requests: string[] = [];
  const listener: http.RequestListener = (req, res) => {
    requests.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 'yes' : 'no'}`);
    handle(config, req, res).catch((err: unknown) => send(res, 500, String(err)));
  };
  const server = config.tls
    ? https.createServer(
        { cert: await fs.readFile(TLS_CERT), key: await fs.readFile(TLS_KEY) },
        listener,
      )
    : http.createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${config.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
