/**
 * A local stand-in for a Jenkins server and a web server directory listing, used by the unit
 * tests, the integration tests and the sandbox. Never talk to real servers in tests.
 *
 *   /job/<job>/api/json                    Jenkins JSON API (builds newest first)
 *   /job/<job>/<n>/artifact/<path>         build artifacts
 *   /vsix/                                 nginx-style autoindex HTML of `autoindex.dir`
 *   /vsix/<file>                           files from that folder
 *   /redirect?to=<path>                    302 to another path (redirect tests)
 *   /npm/…                                 npm registry: packuments, tarballs, search API
 *
 * With `auth`, every /job/ request needs HTTP basic auth. With `npm.token`, every registry
 * request needs `Authorization: Bearer <token>`.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
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

export interface FakeNpmVersion {
  /** The package tarball (see `makeTgz`). */
  tgz: Buffer;
  /** Extra package.json fields, e.g. `vscodeExtension`. `dist` entries override the computed ones. */
  manifest?: Record<string, unknown>;
}

export interface FakeServerConfig {
  tls?: boolean;
  auth?: { user: string; password: string };
  jenkins?: { job: string; builds: FakeBuild[] };
  autoindex?: { dir: string };
  /** npm registry at `/npm/`. */
  npm?: {
    token?: string;
    /** Set to false to emulate registries without the search API. */
    search?: boolean;
    packages: Record<string, Record<string, FakeNpmVersion>>;
  };
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

  if (config.npm && p.startsWith('/npm/')) {
    handleNpm(config.npm, req, res, url);
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

function handleNpm(
  npm: NonNullable<FakeServerConfig['npm']>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): void {
  if (npm.token && req.headers.authorization !== `Bearer ${npm.token}`) {
    send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json');
    return;
  }
  // Keep `%2f` encoded while splitting, as registries see it.
  const rest = url.pathname.slice('/npm/'.length);
  const base = `${req.headers.host ? `${url.protocol === 'https:' ? 'https' : 'http'}://${req.headers.host}` : ''}/npm`;

  if (rest === '-/v1/search') {
    if (npm.search === false) {
      send(res, 404, 'Not found');
      return;
    }
    const text = url.searchParams.get('text') ?? '';
    const scope = /scope:(\S+)/.exec(text)?.[1];
    const names = Object.keys(npm.packages).filter((n) => !scope || n.startsWith(`@${scope}/`));
    const body = { objects: names.map((name) => ({ package: { name } })), total: names.length };
    send(res, 200, JSON.stringify(body), 'application/json');
    return;
  }

  const tarball = /^(.+)\/-\/(.+)-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(decodeURIComponent(rest));
  if (tarball) {
    const v = npm.packages[tarball[1]!]?.[tarball[3]!];
    if (v) {
      send(res, 200, v.tgz, 'application/octet-stream');
    } else {
      send(res, 404, 'Not found');
    }
    return;
  }

  const name = decodeURIComponent(rest);
  const pkg = npm.packages[name];
  if (!pkg) {
    send(res, 404, JSON.stringify({ error: 'not found' }), 'application/json');
    return;
  }
  const unscoped = name.replace(/^@[^/]+\//, '');
  const versions = Object.fromEntries(
    Object.entries(pkg).map(([version, v]) => {
      const { dist, ...manifest } = v.manifest ?? {};
      return [
        version,
        {
          name,
          version,
          ...manifest,
          dist: {
            tarball: `${base}/${name}/-/${unscoped}-${version}.tgz`,
            integrity: `sha512-${createHash('sha512').update(v.tgz).digest('base64')}`,
            shasum: createHash('sha1').update(v.tgz).digest('hex'),
            ...(dist as object | undefined),
          },
        },
      ];
    }),
  );
  send(res, 200, JSON.stringify({ name, versions }), 'application/json');
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

export interface FakeProxy {
  url: string;
  /** `CONNECT host:port` tunnels and absolute-URI requests seen, in order. */
  seen: string[];
  close(): Promise<void>;
}

/** Host names under this (reserved, never publicly resolvable) domain point to 127.0.0.1. */
export const PROXY_ONLY_DOMAIN = 'leuchtturm.test';

/** `jenkins` + `http://127.0.0.1:1234` → `http://jenkins.leuchtturm.test:1234` */
export function proxyOnlyUrl(name: string, url: string): string {
  return url.replace('127.0.0.1', `${name}.${PROXY_ONLY_DOMAIN}`);
}

function resolveHost(host: string): string {
  return host.endsWith(`.${PROXY_ONLY_DOMAIN}`) ? '127.0.0.1' : host;
}

/**
 * A forward proxy like a company proxy: tunnels HTTPS with CONNECT, forwards plain HTTP
 * requests with absolute URIs, and optionally requires `Proxy-Authorization`. It resolves
 * `*.leuchtturm.test` to 127.0.0.1, so URLs with those names only work through the proxy.
 * A direct request for `/__seen` returns what it has seen (for tests in another process).
 */
export async function startFakeProxy(options: { authorization?: string } = {}): Promise<FakeProxy> {
  const seen: string[] = [];
  const denied = (header: string | undefined) =>
    options.authorization !== undefined && header !== options.authorization;
  const server = http.createServer((req, res) => {
    if (req.url === '/__seen') {
      send(res, 200, JSON.stringify(seen), 'application/json');
      return;
    }
    if (!req.url?.startsWith('http://')) {
      send(res, 400, 'Not a proxy request');
      return;
    }
    if (denied(req.headers['proxy-authorization'])) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' }).end();
      return;
    }
    seen.push(`GET ${req.url}`);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const target = new URL(req.url);
    const upstream = http.request(
      {
        host: resolveHost(target.hostname),
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => send(res, 502, 'Bad gateway'));
    req.pipe(upstream);
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    if (denied(req.headers['proxy-authorization'])) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n',
      );
      return;
    }
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? '').split(':');
    tunnels.add(client);
    client.on('close', () => tunnels.delete(client));
    const upstream = net.connect(Number(port), resolveHost(host ?? ''), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  // Tunnelled sockets are no longer tracked by the HTTP server, so closeAllConnections()
  // misses them and close() would wait for them forever.
  const tunnels = new Set<net.Socket>();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        tunnels.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}
