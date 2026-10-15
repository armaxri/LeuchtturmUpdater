/**
 * `npm` source (SPEC §6.3): VSIX files wrapped in npm packages on any registry (Nexus,
 * Artifactory, Verdaccio, GitHub Packages…). Talks to the registry HTTP API directly; the
 * npm CLI is not needed.
 *
 * Package convention: the package contains exactly one `.vsix` at its root. The extension ID
 * comes from `"vscodeExtension": "publisher.name"` in package.json, or `publisher` plus the
 * unscoped package name (an extension's own package.json), or else from the `.vsix` file name
 * inside the newest version's tarball.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_FILE_PATTERN } from './fileConfig';
import { errorMessage, type Logger } from '../log';
import { throwIfCancelled, type CancellationToken } from '../util/cancellation';
import { verifyIntegrity } from '../util/hash';
import { httpRequest, HttpError } from '../util/http';
import { findNpmrcAuth, parseNpmrc } from '../util/npmrc';
import { readTgz } from '../util/tar';
import { compareVersions, isValidVersion } from '../version';
import type { NpmSourceConfig } from './npmConfig';
import { Requester } from './requester';
import type { Artifact, AvailableVersion, Reporter, Source } from './types';

interface PackumentVersion {
  version?: string;
  vscodeExtension?: unknown;
  publisher?: unknown;
  displayName?: unknown;
  deprecated?: unknown;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
}

interface Packument {
  name?: string;
  versions?: Record<string, PackumentVersion>;
}

const PACKUMENT_MAX_BYTES = 50 * 1024 * 1024;
const TARBALL_MAX_BYTES = 256 * 1024 * 1024;
const PARALLEL_REQUESTS = 4;
const VSIX_NAME = new RegExp(DEFAULT_FILE_PATTERN, 'i');

/**
 * Extension IDs derived from tarball contents, by tarball URL + integrity. Module-level so it
 * survives the source being recreated on every check; a tarball never changes its contents.
 */
const derivedIds = new Map<string, string>();

/** `@scope/name` → `@scope%2fname`, as the registry API expects. */
function encodePackage(name: string): string {
  return name.replace('/', '%2f');
}

/** Picks the single `.vsix` at the package root (`package/x.vsix`, or `x.vsix`). */
export function findRootVsix(entries: { name: string; type: string; data: Buffer }[]) {
  const files = entries.filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.vsix'));
  let root = files.filter((e) => e.name.split('/').filter(Boolean).length === 2);
  if (root.length === 0) {
    root = files.filter((e) => !e.name.includes('/'));
  }
  if (root.length === 0) {
    const nested = files.map((f) => f.name).join(', ');
    throw new Error(
      `The package contains no .vsix at its root${nested ? ` (found: ${nested})` : ''}`,
    );
  }
  if (root.length > 1) {
    throw new Error(
      `The package contains several .vsix files: ${root.map((f) => f.name).join(', ')}`,
    );
  }
  return root[0]!;
}

export class NpmSource implements Source {
  readonly type = 'npm' as const;
  readonly name: string;
  readonly warnings: string[] = [];
  private readonly requester: Requester;
  private npmrcAuth: Promise<string | undefined> | undefined;

  constructor(
    private readonly config: NpmSourceConfig,
    timeoutMs: number,
    private readonly log: Logger,
    private readonly addSecret: (value: string) => void,
  ) {
    this.name = config.name;
    if (!config.strictSSL) {
      this.warnings.push('TLS certificate verification is disabled ("strictSSL": false)');
    }
    this.requester = new Requester({
      strictSSL: config.strictSSL,
      caPath: config.caPath,
      timeoutMs,
      authorization: () => this.authorization(),
    });
  }

  /** `auth` from the settings, or else the matching entry of the `.npmrc` (read once). */
  private authorization(): Promise<string | undefined> {
    if (this.config.authorization) {
      return Promise.resolve(this.config.authorization);
    }
    this.npmrcAuth ??= fs
      .readFile(this.config.npmrcPath, 'utf8')
      .then((text) => {
        const auth = findNpmrcAuth(parseNpmrc(text), this.config.registry);
        auth?.sensitive.forEach((s) => this.addSecret(s));
        if (auth) {
          this.log.debug(`[${this.name}] using credentials from ${this.config.npmrcPath}`);
        }
        return auth?.authorization;
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          this.log.warn(`[${this.name}] cannot read ${this.config.npmrcPath}: ${err.message}`);
        }
        return undefined;
      });
    return this.npmrcAuth;
  }

  private async getJson<T>(url: string, token: CancellationToken, report: Reporter): Promise<T> {
    const start = Date.now();
    const res = await httpRequest(url, {
      ...(await this.requester.options(token, { accept: 'application/json' })),
      maxBytes: PACKUMENT_MAX_BYTES,
    });
    this.log.debug(
      `[${this.name}] GET ${url} → ${res.status} (${res.body.length} bytes, ${Date.now() - start} ms)`,
    );
    report(`GET ${url} → HTTP ${res.status}, ${res.body.length} bytes`);
    try {
      return JSON.parse(res.body.toString('utf8')) as T;
    } catch {
      throw new Error(`${url} did not return JSON`);
    }
  }

  /** All package names of the configured scope, via the npm search API (paged). */
  private async search(token: CancellationToken, report: Reporter): Promise<string[]> {
    const scope = this.config.scope!;
    const names = new Set<string>();
    const size = 250;
    for (let from = 0; from < 10 * size; from += size) {
      const url = `${this.config.registry}-/v1/search?text=${encodeURIComponent(`scope:${scope.slice(1)}`)}&size=${size}&from=${from}`;
      let page: { objects?: { package?: { name?: string } }[]; total?: number };
      try {
        page = await this.getJson(url, token, report);
      } catch (err) {
        if (
          err instanceof HttpError &&
          (err.status === 404 || err.status === 405 || err.status === 501)
        ) {
          throw new Error(
            `The registry does not support the search API (HTTP ${err.status}). List the packages in "packages" instead of using "scope".`,
            { cause: err },
          );
        }
        throw err;
      }
      const objects = page.objects ?? [];
      for (const o of objects) {
        const name = o.package?.name;
        if (name?.startsWith(`${scope}/`)) {
          names.add(name);
        }
      }
      if (objects.length < size || (page.total !== undefined && from + size >= page.total)) {
        break;
      }
    }
    report(`Search for ${scope}: ${names.size} package(s): ${[...names].join(', ') || '—'}`);
    return [...names].sort();
  }

  private async fetchTarball(url: string, token: CancellationToken): Promise<Buffer> {
    // Send credentials only to the registry's own host, never to a CDN elsewhere.
    const sameOrigin = new URL(url).origin === new URL(this.config.registry).origin;
    const res = await httpRequest(url, {
      ...(await this.requester.options(
        token,
        {},
        {
          withAuth: sameOrigin,
          timeoutMs: Math.max(this.requester.timeoutMs * 10, 5 * 60_000),
        },
      )),
      maxBytes: TARBALL_MAX_BYTES,
    });
    return res.body;
  }

  /** Extension ID from the `.vsix` file name inside a tarball (cached). */
  private async deriveId(v: PackumentVersion, token: CancellationToken): Promise<string> {
    const tarball = v.dist?.tarball;
    if (!tarball) {
      throw new Error('no dist.tarball to derive the extension ID from');
    }
    const key = `${tarball}#${v.dist?.integrity ?? v.dist?.shasum ?? ''}`;
    const cached = derivedIds.get(key);
    if (cached) {
      return cached;
    }
    const data = await this.fetchTarball(tarball, token);
    verifyIntegrity(data, v.dist?.integrity, v.dist?.shasum);
    const vsix = findRootVsix(await readTgz(data));
    const id = VSIX_NAME.exec(path.posix.basename(vsix.name))?.groups?.id;
    if (!id) {
      throw new Error(
        `cannot derive the extension ID from "${vsix.name}"; add "vscodeExtension" to package.json`,
      );
    }
    derivedIds.set(key, id);
    return id;
  }

  private async listPackage(
    pkg: string,
    token: CancellationToken,
    report: Reporter,
  ): Promise<{ id: string; displayName?: string; version: AvailableVersion }[]> {
    const packument = await this.getJson<Packument>(
      `${this.config.registry}${encodePackage(pkg)}`,
      token,
      report,
    );
    const unscoped = pkg.replace(/^@[^/]+\//, '');
    const out: {
      id?: string;
      displayName?: string;
      manifest: PackumentVersion;
      version: AvailableVersion;
    }[] = [];
    for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
      if (!isValidVersion(version)) {
        report(`  ${pkg}@${version}: skipped, not a semver version`);
        continue;
      }
      if (manifest.deprecated) {
        report(`  ${pkg}@${version}: skipped, deprecated (${String(manifest.deprecated)})`);
        continue;
      }
      if (!manifest.dist?.tarball) {
        report(`  ${pkg}@${version}: skipped, no dist.tarball`);
        continue;
      }
      const id =
        typeof manifest.vscodeExtension === 'string'
          ? manifest.vscodeExtension
          : typeof manifest.publisher === 'string'
            ? `${manifest.publisher}.${unscoped}`
            : undefined;
      const ref: Record<string, string> = { package: pkg, tarball: manifest.dist.tarball };
      if (manifest.dist.integrity) {
        ref.integrity = manifest.dist.integrity;
      }
      if (manifest.dist.shasum) {
        ref.shasum = manifest.dist.shasum;
      }
      out.push({
        id,
        displayName: typeof manifest.displayName === 'string' ? manifest.displayName : undefined,
        manifest,
        version: { version, ref },
      });
    }

    // Versions without an ID in package.json: derive it from the newest one's tarball.
    const missing = out.filter((o) => !o.id);
    if (missing.length > 0) {
      const newest = [...missing].sort((a, b) =>
        compareVersions(b.version.version, a.version.version),
      )[0]!;
      try {
        const derived = await this.deriveId(newest.manifest, token);
        report(
          `  ${pkg}: extension ID ${derived} taken from the .vsix in ${newest.version.version}`,
        );
        missing.forEach((o) => (o.id = derived));
      } catch (err) {
        report(`  ${pkg}: skipped ${missing.length} version(s): ${errorMessage(err)}`);
      }
    }
    const result = out.filter((o): o is typeof o & { id: string } => o.id !== undefined);
    for (const o of result) {
      report(
        `  matched  ${pkg}@${o.version.version} → ${o.id} ${o.version.version}  tarball ${o.version.ref.tarball}`,
      );
    }
    return result;
  }

  async list(token: CancellationToken, report: Reporter = () => undefined): Promise<Artifact[]> {
    if (!this.config.strictSSL) {
      this.log.warn(`[${this.name}] ${this.warnings[0]}`);
    }
    report(`Registry: ${this.config.registry}`);
    const packages =
      this.config.packages.length > 0 ? this.config.packages : await this.search(token, report);

    // A few requests at a time: fast, without hammering the registry.
    const found: Awaited<ReturnType<NpmSource['listPackage']>> = [];
    const queue = [...packages];
    const errors: string[] = [];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_REQUESTS, queue.length) }, async () => {
        for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
          throwIfCancelled(token);
          try {
            found.push(...(await this.listPackage(pkg, token, report)));
          } catch (err) {
            const message = `${pkg}: ${errorMessage(err)}`;
            report(`  FAILED ${message}`);
            errors.push(message);
          }
        }
      }),
    );
    // One broken package must not hide the others, but if everything failed, say so.
    if (errors.length > 0 && errors.length === packages.length) {
      throw new Error(
        errors.length === 1 ? errors[0]! : `${errors.length} packages failed: ${errors.join('; ')}`,
      );
    }
    for (const e of errors) {
      this.log.warn(`[${this.name}] ${e}`);
    }

    const byId = new Map<string, Artifact>();
    for (const f of found) {
      const key = f.id.toLowerCase();
      const artifact = byId.get(key) ?? {
        id: f.id,
        kind: 'vscode-extension' as const,
        versions: [],
      };
      artifact.displayName ??= f.displayName;
      byId.set(key, artifact);
      if (!artifact.versions.some((v) => v.version === f.version.version)) {
        artifact.versions.push(f.version);
      }
    }
    for (const a of byId.values()) {
      a.versions.sort((x, y) => compareVersions(y.version, x.version));
    }
    return [...byId.values()];
  }

  async download(
    artifact: Artifact,
    version: AvailableVersion,
    targetDir: string,
    token: CancellationToken,
  ): Promise<string> {
    const { tarball, integrity, shasum } = version.ref;
    if (!tarball) {
      throw new Error(`[${this.name}] ${artifact.id}@${version.version} has no tarball URL`);
    }
    this.log.info(`[${this.name}] downloading ${tarball}`);
    const data = await this.fetchTarball(tarball, token);
    const checked = verifyIntegrity(data, integrity, shasum);
    this.log.info(
      checked
        ? `[${this.name}] integrity verified (${checked})`
        : `[${this.name}] the registry published no integrity hash for ${tarball}`,
    );
    const vsix = findRootVsix(await readTgz(data));
    await fs.mkdir(targetDir, { recursive: true });
    const dest = path.join(targetDir, `${artifact.id}-${version.version}.vsix`);
    await fs.writeFile(dest, vsix.data);
    return dest;
  }
}
