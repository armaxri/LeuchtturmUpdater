/**
 * Runs all sources and turns their results into an update state (SPEC §4.2).
 * A check never installs anything; it only computes what the UI shows.
 */

import type { ConfigProblem, TrackingEntry } from './config';
import { errorMessage, type Logger } from './log';
import type { Artifact, ArtifactKind, AvailableVersion, Source, SourceType } from './sources/types';
import { withTimeout, type CancellationToken } from './util/cancellation';
import { matchesFilters } from './util/glob';
import { compareVersions, isPrerelease, satisfies } from './version';

export interface SourceEntry {
  source: Source;
  timeoutMs: number;
  include: readonly string[];
  exclude: readonly string[];
}

export interface SourceResult {
  source: string;
  type: SourceType;
  artifacts: Artifact[];
  error?: string;
  /** Configuration warnings of the source (e.g. TLS verification off). */
  warnings?: readonly string[];
  durationMs: number;
}

/** Runs `list()` on every source in parallel. One failing source never affects the others. */
export async function listAll(
  entries: readonly SourceEntry[],
  token: CancellationToken,
  log: Logger,
): Promise<SourceResult[]> {
  return Promise.all(
    entries.map(async ({ source, timeoutMs, include, exclude }): Promise<SourceResult> => {
      const start = Date.now();
      try {
        const all = await withTimeout(
          timeoutMs,
          token,
          (t) => source.list(t),
          `Source "${source.name}"`,
        );
        const artifacts = all.filter((a) => matchesFilters(a.id, include, exclude));
        log.info(
          `[${source.name}] ${artifacts.length} artifact(s)` +
            (artifacts.length !== all.length
              ? ` (${all.length - artifacts.length} filtered)`
              : '') +
            ` in ${Date.now() - start} ms`,
        );
        return {
          source: source.name,
          type: source.type,
          artifacts,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        log.error(`[${source.name}] ${errorMessage(err)}`);
        return {
          source: source.name,
          type: source.type,
          artifacts: [],
          error: errorMessage(err),
          warnings: source.warnings,
          durationMs: Date.now() - start,
        };
      }
    }),
  );
}

/** One downloadable version of an artifact, together with where it comes from. */
export interface Candidate {
  version: string;
  sourceName: string;
  sourceType: SourceType;
  /** The artifact as reported by that source. */
  artifact: Artifact;
  available: AvailableVersion;
}

export type ArtifactStatus = 'update' | 'up-to-date' | 'not-installed' | 'skipped';

export interface ArtifactState {
  id: string;
  displayName?: string;
  kind: ArtifactKind;
  installedVersion?: string;
  status: ArtifactStatus;
  /** Best candidate (highest allowed version), if any. */
  latest?: Candidate;
  /** All allowed candidates, newest first, one per version. */
  candidates: Candidate[];
  pin?: string;
}

/** Display name, falling back to the ID. */
export function artifactLabel(a: { id: string; displayName?: string }): string {
  return a.displayName ?? a.id;
}

export interface Problem {
  source?: string;
  artifactId?: string;
  message: string;
}

export interface CheckState {
  checkedAt: number;
  artifacts: ArtifactState[];
  problems: Problem[];
  /** Warnings per source name, shown in tooltips. */
  sourceWarnings: Record<string, readonly string[]>;
}

export interface ComputeInput {
  /** In settings order; this order breaks ties between sources. */
  results: readonly SourceResult[];
  tracking: readonly TrackingEntry[];
  trackAllFromSources: boolean;
  includePrerelease: boolean;
  installedVersion: (id: string) => string | undefined;
  /** Fallback display name for artifacts whose sources report none (e.g. installed name). */
  displayName?: (id: string) => string | undefined;
  isSkipped: (id: string, version: string) => boolean;
  configProblems?: readonly ConfigProblem[];
  now?: number;
}

/** Merges source results into per-artifact states and problems. Pure; easy to unit test. */
export function computeState(input: ComputeInput): CheckState {
  const problems: Problem[] = (input.configProblems ?? []).map((p) => ({ ...p }));
  for (const r of input.results) {
    if (r.error) {
      problems.push({ source: r.source, message: `${r.source}: ${r.error}` });
    }
  }

  // Every offered version per artifact, by lowercase ID. Order: source order, then the
  // source's own order, so the first entry of a version is the tie-break winner.
  const offered = new Map<string, Candidate[]>();
  for (const r of input.results) {
    for (const artifact of r.artifacts) {
      const key = artifact.id.toLowerCase();
      const list = offered.get(key) ?? [];
      offered.set(key, list);
      for (const available of artifact.versions) {
        list.push({
          version: available.version,
          sourceName: r.source,
          sourceType: r.type,
          artifact,
          available,
        });
      }
    }
  }

  const sourceNames = new Set(input.results.map((r) => r.source));
  const tracked = new Map<string, TrackingEntry>();
  for (const entry of input.tracking) {
    tracked.set(entry.id.toLowerCase(), entry);
    if (entry.source && !sourceNames.has(entry.source)) {
      problems.push({
        artifactId: entry.id,
        message: `${entry.id}: source "${entry.source}" is not configured or disabled`,
      });
    }
  }

  // Which IDs to show (SPEC §6.2): explicit entries; with an empty list every installed
  // artifact that some source offers; with trackAllFromSources everything offered.
  const ids = new Map<string, string>(); // lowercase → display ID
  for (const entry of input.tracking) {
    ids.set(entry.id.toLowerCase(), entry.id);
  }
  for (const [key, candidates] of offered) {
    const id = candidates[0]?.artifact.id ?? key;
    if (
      !ids.has(key) &&
      (input.trackAllFromSources ||
        (input.tracking.length === 0 && input.installedVersion(id) !== undefined))
    ) {
      ids.set(key, id);
    }
  }

  const artifacts: ArtifactState[] = [];
  for (const [key, id] of ids) {
    const entry = tracked.get(key);
    let candidates = offered.get(key) ?? [];
    if (entry?.source) {
      candidates = candidates.filter((c) => c.sourceName === entry.source);
    }
    const offeredAtAll = candidates.length > 0;
    candidates = candidates.filter(
      (c) =>
        (input.includePrerelease || !isPrerelease(c.version)) &&
        (!entry?.pinRange || satisfies(c.version, entry.pinRange)),
    );
    // Stable sort keeps source order among equal versions; then keep the first of each.
    candidates = [...candidates].sort((a, b) => compareVersions(b.version, a.version));
    candidates = candidates.filter(
      (c, i) => i === 0 || compareVersions(c.version, candidates[i - 1]!.version) !== 0,
    );

    if (candidates.length === 0) {
      if (!entry) {
        // Picked up implicitly and only prereleases are offered: nothing to show or report.
        continue;
      }
      const where = entry.source ? `source "${entry.source}"` : 'any source';
      problems.push({
        artifactId: id,
        message: offeredAtAll
          ? `${id}: no version matches ${entry.pin ? `pin "${entry.pin}"` : 'the filters'} (prereleases ${input.includePrerelease ? 'included' : 'excluded'})`
          : `${id} is not offered by ${where}`,
      });
      continue;
    }

    const latest = candidates[0]!;
    const installedVersion = input.installedVersion(latest.artifact.id);
    let status: ArtifactStatus;
    if (installedVersion === undefined) {
      status = 'not-installed';
    } else if (compareVersions(latest.version, installedVersion) > 0) {
      status = input.isSkipped(latest.artifact.id, latest.version) ? 'skipped' : 'update';
    } else {
      status = 'up-to-date';
    }
    artifacts.push({
      id: latest.artifact.id,
      displayName:
        candidates.find((c) => c.artifact.displayName)?.artifact.displayName ??
        input.displayName?.(latest.artifact.id),
      kind: latest.artifact.kind,
      installedVersion,
      status,
      latest,
      candidates,
      pin: entry?.pin,
    });
  }

  artifacts.sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id));
  const sourceWarnings: Record<string, readonly string[]> = {};
  for (const r of input.results) {
    if (r.warnings?.length) {
      sourceWarnings[r.source] = r.warnings;
    }
  }
  return { checkedAt: input.now ?? Date.now(), artifacts, problems, sourceWarnings };
}
