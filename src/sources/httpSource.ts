/**
 * `http` source (SPEC §6.4): fetch an index page or API, extract versions with a regex or
 * JSONPath matcher, and build the download request from the captured values. Covers Jenkins,
 * plain web server directory listings, Artifactory, GitLab/Gitea package APIs and similar.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { errorMessage, type Logger } from '../log';
import type { CancellationToken } from '../util/cancellation';
import { httpDownload, httpRequest } from '../util/http';
import { expandTemplate } from '../util/template';
import { compareVersions, isValidVersion } from '../version';
import type { HttpSourceConfig } from './httpConfig';
import { extractMatches } from './httpMatcher';
import type { Artifact, AvailableVersion, Reporter, Source } from './types';

const PREVIEW_BYTES = 2048;
/** Downloads may be large: allow far more time than for the index request. */
const MIN_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class HttpSource implements Source {
  readonly type = 'http' as const;
  readonly name: string;

  constructor(
    private readonly config: HttpSourceConfig,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {
    this.name = config.name;
  }

  /** Expands a per-version template with the matched groups plus id/version. */
  private expand(
    template: string,
    ref: Record<string, string>,
    extra: Record<string, string> = {},
  ) {
    return expandTemplate(template, {
      ...this.config.templateContext,
      vars: { ...ref, ...extra },
    });
  }

  async list(token: CancellationToken, report: Reporter = () => undefined): Promise<Artifact[]> {
    const { url, method, body } = this.config.index;
    const start = Date.now();
    report(`${method} ${url}`);
    const res = await httpRequest(url, { timeoutMs: this.timeoutMs, token, method, body });
    const text = res.body.toString('utf8');
    const summary = `${method} ${url} → ${res.status} (${res.body.length} bytes, ${Date.now() - start} ms)`;
    this.log.debug(`[${this.name}] ${summary}`);
    report(`→ HTTP ${res.status} ${res.statusText}, ${res.body.length} bytes`);
    if (res.url !== url) {
      report(`  (redirected to ${res.url})`);
    }
    report(`--- first ${Math.min(PREVIEW_BYTES, text.length)} characters of the body ---`);
    report(text.slice(0, PREVIEW_BYTES));
    report('--- end of preview ---');

    const { records, skipped } = extractMatches(text, this.config.match);
    for (const s of skipped) {
      report(`  skipped  ${s}`);
    }
    const byId = new Map<string, { id: string; versions: AvailableVersion[]; seen: Set<string> }>();
    for (const record of records) {
      const id = this.config.match.id ?? record.id;
      const version = record.version;
      const groups = JSON.stringify(record);
      if (!id || !version) {
        report(`  skipped  ${groups}: no ${id ? 'version' : 'id'}`);
        continue;
      }
      if (!isValidVersion(version)) {
        report(`  skipped  ${groups}: "${version}" is not a semver version`);
        continue;
      }
      const key = id.toLowerCase();
      const entry = byId.get(key) ?? { id, versions: [], seen: new Set<string>() };
      byId.set(key, entry);
      // First match wins, so a newest-first index picks the newest build of a version.
      if (entry.seen.has(version)) {
        report(`  duplicate ${id} ${version}, ignored`);
        continue;
      }
      entry.seen.add(version);
      const ref = { ...record, id, version };
      const available: AvailableVersion = { version, ref };
      if (this.config.releaseNotesUrl) {
        try {
          available.releaseNotesUrl = this.expand(this.config.releaseNotesUrl, ref);
        } catch (err) {
          report(`  release notes URL for ${id} ${version}: ${errorMessage(err)}`);
        }
      }
      let downloadUrl: string;
      try {
        downloadUrl = this.expand(this.config.download.url, ref, { targetDir: '' });
      } catch (err) {
        downloadUrl = `cannot resolve: ${errorMessage(err)}`;
      }
      this.log.trace(`[${this.name}] match ${groups}`);
      report(`  matched  ${id} ${version}  groups ${groups}`);
      report(`           download ${downloadUrl}`);
      entry.versions.push(available);
    }
    return [...byId.values()].map(({ id, versions }) => ({
      id,
      kind: 'vscode-extension' as const,
      versions: versions.sort((a, b) => compareVersions(b.version, a.version)),
    }));
  }

  async download(
    artifact: Artifact,
    version: AvailableVersion,
    targetDir: string,
    token: CancellationToken,
  ): Promise<string> {
    const extra = { id: artifact.id, version: version.version, targetDir };
    const url = this.expand(this.config.download.url, version.ref, extra);
    await fs.mkdir(targetDir, { recursive: true });
    // Our own file name: never trust a server-provided name for a local path.
    const dest = path.join(targetDir, `${artifact.id}-${version.version}.vsix`);
    this.log.info(`[${this.name}] downloading ${url}`);
    const timeoutMs = Math.max(this.timeoutMs * 10, MIN_DOWNLOAD_TIMEOUT_MS);
    const res = await httpDownload(url, dest, { timeoutMs, token });
    this.log.info(`[${this.name}] downloaded ${res.bytes} bytes from ${res.url}`);
    return dest;
  }

  async fetchReleaseNotes(
    _artifact: Artifact,
    version: AvailableVersion,
    token: CancellationToken,
  ): Promise<string | undefined> {
    if (!version.releaseNotesUrl) {
      return undefined;
    }
    const res = await httpRequest(version.releaseNotesUrl, {
      timeoutMs: this.timeoutMs,
      token,
      maxBytes: 1024 * 1024,
    });
    return res.body.toString('utf8');
  }
}
