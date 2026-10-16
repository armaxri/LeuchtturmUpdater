/**
 * `npm` source (SPEC §6.3): VSIX files wrapped in npm packages on any registry (Nexus,
 * Artifactory, Verdaccio, GitHub Packages…). Runs the user's own npm CLI (`npm view`,
 * `npm search`, `npm pack`), so it works with whatever npm is configured for: registries,
 * `npm login`, certificates. Leuchtturm itself handles no credentials.
 *
 * Package convention: the package contains exactly one `.vsix` at its root. The extension ID
 * comes from `"vscodeExtension": "publisher.name"` in package.json, or `publisher` plus the
 * unscoped package name (an extension's own package.json), or else from the `.vsix` file name
 * inside the newest version's package.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { errorMessage, type Logger } from '../log';
import { throwIfCancelled, type CancellationToken } from '../util/cancellation';
import { runNpm } from '../util/npmCli';
import { readTgz } from '../util/tar';
import { compareVersions, isValidVersion } from '../version';
import { DEFAULT_FILE_PATTERN } from './fileConfig';
import type { NpmSourceConfig } from './npmConfig';
import type { Artifact, AvailableVersion, Reporter, Source } from './types';

/** What `npm view <package> --json` prints: the latest manifest plus all version numbers. */
interface NpmView {
  name?: string;
  version?: string;
  versions?: string[] | string;
  vscodeExtension?: unknown;
  publisher?: unknown;
  displayName?: unknown;
}

const PARALLEL_RUNS = 4;
const VSIX_NAME = new RegExp(DEFAULT_FILE_PATTERN, 'i');

/**
 * Extension IDs derived from a package's `.vsix`, by `package@version`. Module-level so it
 * survives the source being recreated on every check; a published version never changes.
 */
const derivedIds = new Map<string, string>();

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

/** npm prints JSON, sometimes with notices around it; take the JSON part. */
function parseJson<T>(stdout: string): T {
  const start = stdout.search(/[[{]/);
  if (start < 0) {
    throw new Error(`npm printed no JSON: ${stdout.slice(0, 200)}`);
  }
  return JSON.parse(stdout.slice(start)) as T;
}

export class NpmSource implements Source {
  readonly type = 'npm' as const;
  readonly name: string;

  constructor(
    private readonly config: NpmSourceConfig,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {
    this.name = config.name;
  }

  /** `--registry …` when the source names one; otherwise npm's configuration decides. */
  private registryArgs(): string[] {
    return this.config.registry ? ['--registry', this.config.registry] : [];
  }

  private async npm(args: string[], token: CancellationToken, report: Reporter, cwd?: string) {
    report(`npm ${args.join(' ')}`);
    this.log.debug(`[${this.name}] npm ${args.join(' ')}`);
    const result = await runNpm(args, {
      timeoutMs: this.timeoutMs,
      token,
      cwd,
      onStderrLine: (line) => this.log.trace(`[${this.name}] npm: ${line}`),
    });
    return result.stdout;
  }

  /** Lists the scope's packages with `npm search`. */
  private async search(token: CancellationToken, report: Reporter): Promise<string[]> {
    const scope = this.config.scope!;
    let registry = this.registryArgs();
    if (registry.length === 0) {
      // `npm search` always asks the default registry, so follow a scope mapping
      // (`@corp:registry=…` in .npmrc) ourselves.
      const mapped = (await this.npm(['config', 'get', `${scope}:registry`], token, report)).trim();
      report(`  → ${mapped || '(empty)'}`);
      if (/^https?:\/\//.test(mapped)) {
        registry = ['--registry', mapped];
      }
    }
    const results = parseJson<{ name?: unknown }[]>(
      await this.npm(
        ['search', scope, '--json', '--searchlimit', '2500', ...registry],
        token,
        report,
      ),
    );
    const names = results
      .map((r) => r.name)
      .filter((n): n is string => typeof n === 'string' && n.startsWith(`${scope}/`));
    report(`Search for ${scope}: ${names.length} package(s): ${names.join(', ') || '—'}`);
    return names;
  }

  /** Downloads `pkg@version` with `npm pack` and returns its `.vsix`. */
  private async pack(
    pkg: string,
    version: string,
    token: CancellationToken,
    report: Reporter = () => undefined,
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-npm-'));
    try {
      const out = parseJson<{ filename?: string }[]>(
        await this.npm(
          [
            'pack',
            `${pkg}@${version}`,
            '--json',
            '--pack-destination',
            dir,
            ...this.registryArgs(),
          ],
          token,
          report,
          dir,
        ),
      );
      const filename = out[0]?.filename;
      if (!filename) {
        throw new Error(`npm pack ${pkg}@${version} did not report a file`);
      }
      // npm verified the package's integrity while downloading it.
      return findRootVsix(await readTgz(await fs.readFile(path.join(dir, filename))));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async listPackage(
    pkg: string,
    token: CancellationToken,
    report: Reporter,
  ): Promise<{ id: string; displayName?: string; versions: AvailableVersion[] }> {
    const view = parseJson<NpmView>(
      await this.npm(['view', pkg, '--json', ...this.registryArgs()], token, report),
    );
    const all = Array.isArray(view.versions) ? view.versions : view.versions ? [view.versions] : [];
    const versions: AvailableVersion[] = [];
    for (const version of all) {
      if (isValidVersion(version)) {
        versions.push({ version, ref: { package: pkg } });
      } else {
        report(`  ${pkg}@${version}: skipped, not a semver version`);
      }
    }
    if (versions.length === 0) {
      throw new Error('no versions');
    }
    versions.sort((a, b) => compareVersions(b.version, a.version));

    const unscoped = pkg.replace(/^@[^/]+\//, '');
    let id =
      typeof view.vscodeExtension === 'string'
        ? view.vscodeExtension
        : typeof view.publisher === 'string'
          ? `${view.publisher}.${unscoped}`
          : undefined;
    if (!id) {
      // No ID in package.json: read it from the .vsix file name of the newest version.
      const newest = versions[0]!.version;
      const key = `${pkg}@${newest}`;
      id = derivedIds.get(key);
      if (!id) {
        const vsix = await this.pack(pkg, newest, token, report);
        id = VSIX_NAME.exec(path.posix.basename(vsix.name))?.groups?.id;
        if (!id) {
          throw new Error(
            `cannot tell the extension ID from "${vsix.name}"; add "vscodeExtension" to package.json`,
          );
        }
        derivedIds.set(key, id);
      }
      report(`  ${pkg}: extension ID ${id} taken from the .vsix in ${newest}`);
    }
    for (const v of versions) {
      report(`  matched  ${pkg}@${v.version} → ${id} ${v.version}`);
    }
    return {
      id,
      displayName: typeof view.displayName === 'string' ? view.displayName : undefined,
      versions,
    };
  }

  async list(token: CancellationToken, report: Reporter = () => undefined): Promise<Artifact[]> {
    report(`Registry: ${this.config.registry ?? 'from your npm configuration'}`);
    const packages =
      this.config.packages.length > 0 ? this.config.packages : await this.search(token, report);

    // A few npm runs at a time: fast, without hammering the registry.
    const found: Awaited<ReturnType<NpmSource['listPackage']>>[] = [];
    const queue = [...packages];
    const errors: string[] = [];
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_RUNS, queue.length) }, async () => {
        for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
          throwIfCancelled(token);
          try {
            found.push(await this.listPackage(pkg, token, report));
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
      for (const v of f.versions) {
        if (!artifact.versions.some((x) => x.version === v.version)) {
          artifact.versions.push(v);
        }
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
    const pkg = version.ref.package;
    if (!pkg) {
      throw new Error(`[${this.name}] ${artifact.id}@${version.version} has no package name`);
    }
    this.log.info(`[${this.name}] npm pack ${pkg}@${version.version}`);
    const vsix = await this.pack(pkg, version.version, token);
    await fs.mkdir(targetDir, { recursive: true });
    const dest = path.join(targetDir, `${artifact.id}-${version.version}.vsix`);
    await fs.writeFile(dest, vsix.data);
    return dest;
  }
}
