/**
 * Small HTTP client on top of `node:http`/`node:https`.
 *
 * Why not the global `fetch`? Node's `fetch` cannot turn off certificate checks or add a CA
 * per request without the `undici` package. `https.request` takes `rejectUnauthorized` and
 * `ca` directly, so this needs no runtime dependency. Proxy support (SPEC §5) plugs in here
 * later as an `agent`.
 */

import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';

import { CancelledError, TimeoutError, type CancellationToken } from './cancellation';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** `false` disables certificate verification. Default `true`. */
  strictSSL?: boolean;
  /** Extra trusted CA certificates (PEM). */
  ca?: string | Buffer;
  token: CancellationToken;
  /** Abort if the response body is larger than this. Default 20 MB (ignored for downloads). */
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  /** Final URL after redirects. */
  url: string;
  body: Buffer;
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    const hint =
      status === 401 || status === 403
        ? ' — check credentials'
        : status === 404
          ? ' — check the URL'
          : '';
    super(`HTTP ${status} ${statusText}${hint} (${url})`);
  }
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** Sends one request (following redirects) and hands the open response to `consume`. */
async function send<T>(
  url: string,
  options: HttpOptions,
  consume: (res: http.IncomingMessage, finalUrl: string) => Promise<T>,
): Promise<T> {
  let current = new URL(url);
  let method = (options.method ?? 'GET').toUpperCase();
  let body = options.body;
  let headers = { ...options.headers };

  for (let hop = 0; ; hop++) {
    const res = await open(current, method, headers, body, options);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume(); // discard the redirect body
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (${url})`);
      }
      const next = new URL(location, current);
      // Never send credentials to a different origin (e.g. a CDN behind a redirect).
      if (next.origin !== current.origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'),
        );
      }
      // 303, and 301/302 after a POST, continue as GET without a body (browser behaviour).
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
      continue;
    }
    return consume(res, current.toString());
  }
}

function open(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  options: HttpOptions,
): Promise<http.IncomingMessage> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported URL protocol "${url.protocol}" in ${url}`));
  }
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (options.token.isCancellationRequested) {
      reject(new CancelledError());
      return;
    }
    const req = lib.request(url, {
      method,
      headers: {
        'user-agent': 'leuchtturm-updater',
        ...headers,
        ...(body !== undefined ? { 'content-length': Buffer.byteLength(body).toString() } : {}),
      },
      rejectUnauthorized: options.strictSSL !== false,
      ca: options.ca,
    });
    const timer = setTimeout(
      () => req.destroy(new TimeoutError(`Request timed out after ${options.timeoutMs / 1000} s`)),
      options.timeoutMs,
    );
    const sub = options.token.onCancellationRequested(() => req.destroy(new CancelledError()));
    const cleanup = (): void => {
      clearTimeout(timer);
      sub.dispose();
    };
    req.on('response', (res) => {
      // The timer and cancellation keep guarding the body until it has been consumed.
      res.on('close', cleanup);
      resolve(res);
    });
    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
    req.end(body);
  });
}

async function readBody(res: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      res.destroy();
      throw new Error(`Response larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Performs a request and returns the whole body. Throws `HttpError` for status >= 400. */
export async function httpRequest(url: string, options: HttpOptions): Promise<HttpResponse> {
  return send(url, options, async (res, finalUrl) => {
    const body = await readBody(res, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const status = res.statusCode ?? 0;
    if (status >= 400) {
      throw new HttpError(
        status,
        res.statusMessage ?? '',
        finalUrl,
        body.subarray(0, 300).toString(),
      );
    }
    return {
      status,
      statusText: res.statusMessage ?? '',
      headers: res.headers,
      url: finalUrl,
      body,
    };
  });
}

/** Streams the response body into `destFile`. Throws `HttpError` for status >= 400. */
export async function httpDownload(
  url: string,
  destFile: string,
  options: HttpOptions,
): Promise<{ status: number; url: string; bytes: number }> {
  return send(url, options, async (res, finalUrl) => {
    const status = res.statusCode ?? 0;
    if (status >= 400) {
      const body = await readBody(res, 64 * 1024).catch(() => Buffer.alloc(0));
      throw new HttpError(
        status,
        res.statusMessage ?? '',
        finalUrl,
        body.subarray(0, 300).toString(),
      );
    }
    try {
      await pipeline(res, createWriteStream(destFile));
    } catch (err) {
      await fs.rm(destFile, { force: true });
      throw err;
    }
    const expected = Number(res.headers['content-length']);
    const { size } = await fs.stat(destFile);
    if (Number.isFinite(expected) && expected > 0 && size !== expected) {
      await fs.rm(destFile, { force: true });
      throw new Error(`Download incomplete: got ${size} of ${expected} bytes (${finalUrl})`);
    }
    return { status, url: finalUrl, bytes: size };
  });
}

/** `Authorization` header value for HTTP basic auth. */
export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}
