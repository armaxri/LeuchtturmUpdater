/**
 * Request options shared by the network sources (`http`, `npm`): timeouts, TLS settings,
 * the CA file (read once) and the `Authorization` header.
 */

import * as fs from 'node:fs/promises';

import { errorMessage } from '../log';
import type { CancellationToken } from '../util/cancellation';
import type { HttpOptions } from '../util/http';
import type { TlsConfig } from './sourceConfig';

export interface RequesterConfig extends TlsConfig {
  timeoutMs: number;
  /** Resolves the `Authorization` header value, if any (may read files such as `.npmrc`). */
  authorization: () => Promise<string | undefined>;
}

export class Requester {
  private ca: Promise<Buffer | undefined> | undefined;

  constructor(private readonly config: RequesterConfig) {}

  get timeoutMs(): number {
    return this.config.timeoutMs;
  }

  private loadCa(): Promise<Buffer | undefined> {
    const caPath = this.config.caPath;
    this.ca ??= caPath
      ? fs.readFile(caPath).catch((err: unknown) => {
          this.ca = undefined; // retry next time, e.g. after the file was fixed
          throw new Error(`Cannot read CA certificate ${caPath}: ${errorMessage(err)}`);
        })
      : Promise.resolve(undefined);
    return this.ca;
  }

  /**
   * Options for one request. The source's `Authorization` is added unless `headers` set
   * their own or `withAuth` is false (e.g. a tarball on another host).
   */
  async options(
    token: CancellationToken,
    headers: Record<string, string> = {},
    { timeoutMs = this.config.timeoutMs, withAuth = true } = {},
  ): Promise<HttpOptions> {
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    const authorization = withAuth && !hasAuth ? await this.config.authorization() : undefined;
    return {
      headers: authorization ? { ...headers, authorization } : headers,
      timeoutMs,
      strictSSL: this.config.strictSSL,
      ca: await this.loadCa(),
      token,
    };
  }
}
