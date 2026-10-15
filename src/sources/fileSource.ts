/**
 * `file` source: a local folder or network share full of `.vsix` files (SPEC §6.1).
 *
 * Supported layouts (same as VSIX Manager):
 *   <path>/<id>-<version>.vsix
 *   <path>/<publisher>/<id>-<version>.vsix
 *   <path>/<id>/<id>-<version>.vsix
 * With `recursive: true`, any sub-folder depth is scanned.
 *
 * Optional sidecars next to a VSIX: `<file>.vsix.sha256` (hash) and `<file>.md` or
 * `<file>.vsix.md` (release notes).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FileSourceConfig } from '../config';
import { errorMessage, type Logger } from '../log';
import { throwIfCancelled, type CancellationToken } from '../util/cancellation';
import { compareVersions, isValidVersion } from '../version';
import type { Artifact, AvailableVersion, Reporter, Source } from './types';

interface Found {
  id: string;
  version: string;
  file: string;
}

interface ScanContext {
  /** All file names per directory, so sidecar lookups need no extra I/O on slow shares. */
  filesByDir: Map<string, Set<string>>;
  found: Found[];
  token: CancellationToken;
  report: Reporter;
}

export class FileSource implements Source {
  readonly type = 'file' as const;
  readonly name: string;

  constructor(
    private readonly config: FileSourceConfig,
    private readonly log: Logger,
  ) {
    this.name = config.name;
  }

  async list(token: CancellationToken, report: Reporter = () => undefined): Promise<Artifact[]> {
    const root = this.config.path;
    this.log.debug(`[${this.name}] scanning ${root}${this.config.recursive ? ' (recursive)' : ''}`);
    // `.catch` turns the low-level error into a readable one; `cause` keeps the original.
    const stat = await fs.stat(root).catch((err: NodeJS.ErrnoException) => {
      throw new Error(
        err.code === 'ENOENT'
          ? `Folder not found: ${root}`
          : `Cannot read ${root}: ${errorMessage(err)}`,
        { cause: err },
      );
    });
    if (!stat.isDirectory()) {
      throw new Error(`${root} is not a folder`);
    }

    report(`Folder: ${root}${this.config.recursive ? ' (recursive)' : ''}`);
    report(`File pattern: ${this.config.filePattern.source}`);
    const ctx: ScanContext = { filesByDir: new Map(), found: [], token, report };
    await this.scan(root, [], ctx);
    const { filesByDir, found } = ctx;

    const byId = new Map<string, { id: string; versions: Map<string, AvailableVersion> }>();
    for (const f of found) {
      const key = f.id.toLowerCase();
      let entry = byId.get(key);
      if (!entry) {
        entry = { id: f.id, versions: new Map() };
        byId.set(key, entry);
      }
      if (entry.versions.has(f.version)) {
        this.log.debug(`[${this.name}] duplicate ${f.id}@${f.version} ignored: ${f.file}`);
        report(`  duplicate, ignored: ${f.file}`);
        continue;
      }
      entry.versions.set(f.version, await this.describe(f, filesByDir));
    }

    const artifacts: Artifact[] = [];
    for (const { id, versions } of byId.values()) {
      artifacts.push({
        id,
        kind: 'vscode-extension',
        versions: [...versions.values()].sort((a, b) => compareVersions(b.version, a.version)),
      });
    }
    this.log.debug(`[${this.name}] found ${artifacts.length} artifact(s), ${found.length} file(s)`);
    return artifacts;
  }

  /** Walks `dir`. `parents` holds the folder names between the root and `dir`. */
  private async scan(dir: string, parents: string[], ctx: ScanContext): Promise<void> {
    throwIfCancelled(ctx.token);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    ctx.filesByDir.set(dir, new Set(entries.filter((e) => e.isFile()).map((e) => e.name)));
    const rel = (name: string) => path.join(...parents, name);
    const skip = (name: string, reason: string, level: 'trace' | 'debug' = 'trace') => {
      this.log[level](`[${this.name}] skipping ${rel(name)}: ${reason}`);
      ctx.report(`  skipped  ${rel(name)}: ${reason}`);
    };

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.vsix')) {
        continue;
      }
      const match = this.config.filePattern.exec(entry.name);
      const id = match?.groups?.id;
      const version = match?.groups?.version;
      if (!id || !version) {
        skip(entry.name, 'does not match the file pattern');
        continue;
      }
      if (!isValidVersion(version)) {
        skip(entry.name, `"${version}" is not a semver version`, 'debug');
        continue;
      }
      if (!this.config.recursive && parents.length === 1 && !this.layoutMatches(parents[0]!, id)) {
        skip(entry.name, `folder "${parents[0]}" is neither the publisher nor the id`);
        continue;
      }
      ctx.report(`  matched  ${rel(entry.name)} → ${id} ${version}`);
      ctx.found.push({ id, version, file: path.join(dir, entry.name) });
    }

    // Non-recursive scans look one level deep for the `<publisher>/` and `<id>/` layouts.
    if (this.config.recursive || parents.length === 0) {
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await this.scan(path.join(dir, entry.name), [...parents, entry.name], ctx);
        }
      }
    } else if (entries.some((e) => e.isDirectory())) {
      ctx.report(`  not scanned: sub-folders of ${path.join(...parents)} (set "recursive": true)`);
    }
  }

  /** In a non-recursive scan, a sub-folder must be named after the publisher or the full ID. */
  private layoutMatches(folder: string, id: string): boolean {
    const f = folder.toLowerCase();
    const lower = id.toLowerCase();
    return f === lower || f === lower.split('.')[0];
  }

  private async describe(
    f: Found,
    filesByDir: Map<string, Set<string>>,
  ): Promise<AvailableVersion> {
    const dir = path.dirname(f.file);
    const base = path.basename(f.file);
    const siblings = filesByDir.get(dir) ?? new Set<string>();
    const v: AvailableVersion = { version: f.version, ref: { path: f.file } };

    const shaName = `${base}.sha256`;
    if (siblings.has(shaName)) {
      // Format of `sha256sum` output: "<hex>  <filename>". Only the first token matters.
      const text = await this.readSidecar(path.join(dir, shaName));
      const hex = text?.trim().split(/\s+/)[0];
      if (hex && /^[0-9a-f]{64}$/i.test(hex)) {
        v.sha256 = hex.toLowerCase();
      } else if (text !== undefined) {
        this.log.warn(`[${this.name}] ignoring ${shaName}: no SHA-256 hex digest found`);
      }
    }

    const stem = base.slice(0, -'.vsix'.length);
    const notesName = [`${base}.md`, `${stem}.md`].find((n) => siblings.has(n));
    if (notesName) {
      v.releaseNotes = await this.readSidecar(path.join(dir, notesName));
    }
    return v;
  }

  private async readSidecar(file: string): Promise<string | undefined> {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      this.log.warn(`[${this.name}] cannot read ${file}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async download(
    artifact: Artifact,
    version: AvailableVersion,
    targetDir: string,
    token: CancellationToken,
  ): Promise<string> {
    const src = version.ref.path;
    if (!src) {
      throw new Error(`[${this.name}] ${artifact.id}@${version.version} has no file path`);
    }
    throwIfCancelled(token);
    // Copy first: never install straight from a share, which may change mid-install.
    const dest = path.join(targetDir, path.basename(src));
    this.log.info(`[${this.name}] copying ${src} → ${dest}`);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.copyFile(src, dest);
    return dest;
  }
}
