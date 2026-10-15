/**
 * Reads and validates `leuchtturm.*` settings (SPEC §5, §6).
 *
 * The parsing is pure: it takes the raw setting values and returns typed config plus a list of
 * problems. Reading from `vscode.workspace` lives in `vscodeSettings.ts`, which also holds the
 * security-relevant rule "sources come only from user settings".
 */

import { SOURCE_TYPES, type SourceType } from './sources/types';
import { expandPath, findSecretNames, TemplateError, type TemplateContext } from './util/template';
import { parseRange, type Range } from './version';

export const DEFAULT_FILE_PATTERN =
  '^(?<id>[\\w-]+\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)\\.vsix$';

export type StatusBarMode = 'always' | 'whenUpdates' | 'never';

export interface Settings {
  enabled: boolean;
  /** 0 = periodic checks disabled. Otherwise at least 5. */
  checkIntervalMinutes: number;
  checkOnStartup: boolean;
  notify: boolean;
  includePrerelease: boolean;
  statusBar: StatusBarMode;
  trackAllFromSources: boolean;
  httpTimeoutSeconds: number;
  scriptTimeoutSeconds: number;
  /** Only the user-level value (SPEC §6.5). */
  scriptEnabled: boolean;
}

interface CommonSourceConfig {
  name: string;
  type: SourceType;
  /** Per-source timeout in seconds, if set. */
  timeoutSeconds?: number;
  include: string[];
  exclude: string[];
}

export interface FileSourceConfig extends CommonSourceConfig {
  type: 'file';
  /** Absolute path after `~` and `${…}` expansion. */
  path: string;
  recursive: boolean;
  filePattern: RegExp;
}

/** Union of all implemented source configs. Grows with each milestone. */
export type SourceConfig = FileSourceConfig;

export interface TrackingEntry {
  id: string;
  /** Restrict to this source name. */
  source?: string;
  /** Original range text, for display. */
  pin?: string;
  pinRange?: Range;
}

export interface ConfigProblem {
  /** The source the problem belongs to, if any. */
  source?: string;
  message: string;
}

export interface Config {
  settings: Settings;
  /** Enabled, valid sources in settings order. */
  sources: SourceConfig[];
  /** Enabled tracking entries. Empty = track installed artifacts offered by any source. */
  tracking: TrackingEntry[];
  problems: ConfigProblem[];
}

/** Accessor for raw setting values by key relative to `leuchtturm.` (e.g. `http.timeout`). */
export type RawSettings = (key: string) => unknown;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSettings(get: RawSettings): Settings {
  const interval = num(get('checkInterval'), 60);
  const statusBar = get('statusBar');
  return {
    enabled: bool(get('enabled'), true),
    checkIntervalMinutes: interval <= 0 ? 0 : Math.max(5, interval),
    checkOnStartup: bool(get('checkOnStartup'), true),
    notify: bool(get('notify'), true),
    includePrerelease: bool(get('includePrerelease'), false),
    statusBar:
      statusBar === 'always' || statusBar === 'never' || statusBar === 'whenUpdates'
        ? statusBar
        : 'whenUpdates',
    trackAllFromSources: bool(get('trackAllFromSources'), false),
    httpTimeoutSeconds: Math.max(1, num(get('http.timeout'), 30)),
    scriptTimeoutSeconds: Math.max(1, num(get('script.timeout'), 120)),
    scriptEnabled: get('script.enabled') === true,
  };
}

class SourceConfigError extends Error {}

function parseFileSource(
  common: CommonSourceConfig,
  raw: Record<string, unknown>,
  ctx: TemplateContext,
): FileSourceConfig {
  if (typeof raw.path !== 'string' || raw.path.trim() === '') {
    throw new SourceConfigError('"path" is required for a file source');
  }
  const patternText = raw.filePattern ?? DEFAULT_FILE_PATTERN;
  if (typeof patternText !== 'string') {
    throw new SourceConfigError('"filePattern" must be a string');
  }
  let filePattern: RegExp;
  try {
    // Case-insensitive because VS Code extension IDs are, and shares often live on Windows.
    filePattern = new RegExp(patternText, 'i');
  } catch (err) {
    throw new SourceConfigError(`"filePattern" is not a valid regex: ${(err as Error).message}`);
  }
  // Every match must name the extension and its version. Probe with a dummy match to check
  // the groups exist without having to parse the regex ourselves.
  const groupNames = new RegExp(`${patternText}|(?<__probe>)`, 'i').exec('')?.groups ?? {};
  for (const g of ['id', 'version']) {
    if (!(g in groupNames)) {
      throw new SourceConfigError(`"filePattern" must contain a named group (?<${g}>…)`);
    }
  }
  return {
    ...common,
    type: 'file',
    path: expandPath(raw.path, ctx),
    recursive: raw.recursive === true,
    filePattern,
  };
}

function parseSource(name: string, raw: unknown, ctx: TemplateContext): SourceConfig | 'disabled' {
  if (!isObject(raw)) {
    throw new SourceConfigError('must be an object');
  }
  if (raw.enabled === false) {
    return 'disabled';
  }
  const type = raw.type;
  if (typeof type !== 'string' || !(SOURCE_TYPES as readonly string[]).includes(type)) {
    throw new SourceConfigError(
      `"type" must be one of ${SOURCE_TYPES.map((t) => `"${t}"`).join(', ')}`,
    );
  }
  if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || raw.timeout <= 0)) {
    throw new SourceConfigError('"timeout" must be a positive number of seconds');
  }
  const common: CommonSourceConfig = {
    name,
    type: type as SourceType,
    timeoutSeconds: raw.timeout as number | undefined,
    include: stringList(raw.include),
    exclude: stringList(raw.exclude),
  };
  switch (type) {
    case 'file':
      return parseFileSource(common, raw, ctx);
    default:
      throw new SourceConfigError(
        `source type "${type}" is not supported by this version of Leuchtturm yet`,
      );
  }
}

/** Parses one `leuchtturm.extensions` entry. Returns undefined for disabled entries. */
function parseTrackingEntry(raw: unknown): TrackingEntry | undefined {
  if (typeof raw === 'string') {
    const text = raw.trim();
    // `source:publisher.name`. IDs never contain a colon, so the first one splits.
    const colon = text.indexOf(':');
    if (colon > 0) {
      return { id: text.slice(colon + 1).trim(), source: text.slice(0, colon).trim() };
    }
    return { id: text };
  }
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') {
    throw new Error('entries must be "publisher.name", "source:publisher.name" or { "id": … }');
  }
  if (raw.enabled === false) {
    return undefined;
  }
  const entry: TrackingEntry = { id: raw.id.trim() };
  if (typeof raw.source === 'string' && raw.source !== '') {
    entry.source = raw.source;
  }
  if (typeof raw.pin === 'string' && raw.pin.trim() !== '') {
    const range = parseRange(raw.pin);
    if (!range) {
      throw new Error(`"${entry.id}": "pin" is not a valid semver range: "${raw.pin}"`);
    }
    entry.pin = raw.pin;
    entry.pinRange = range;
  }
  return entry;
}

/** Secret names referenced anywhere in the sources setting, so the caller can prefetch them. */
export function referencedSecrets(rawSources: unknown): string[] {
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      strings.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (isObject(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(rawSources);
  return findSecretNames(...strings);
}

/**
 * Parses all settings. Invalid sources and tracking entries become problems; they never stop
 * the remaining configuration from loading (SPEC §4.2 step 1).
 */
export function parseConfig(get: RawSettings, ctx: TemplateContext = {}): Config {
  const settings = parseSettings(get);
  const problems: ConfigProblem[] = [];

  const sources: SourceConfig[] = [];
  const rawSources = get('sources') ?? {};
  if (!isObject(rawSources)) {
    problems.push({ message: '"leuchtturm.sources" must be an object of named sources' });
  } else {
    for (const [name, raw] of Object.entries(rawSources)) {
      try {
        const parsed = parseSource(name, raw, ctx);
        if (parsed !== 'disabled') {
          sources.push(parsed);
        }
      } catch (err) {
        if (err instanceof SourceConfigError || err instanceof TemplateError) {
          problems.push({ source: name, message: `Invalid source "${name}": ${err.message}` });
        } else {
          throw err;
        }
      }
    }
  }

  const tracking: TrackingEntry[] = [];
  const rawTracking = get('extensions') ?? [];
  if (!Array.isArray(rawTracking)) {
    problems.push({ message: '"leuchtturm.extensions" must be an array' });
  } else {
    const seen = new Set<string>();
    for (const raw of rawTracking) {
      try {
        const entry = parseTrackingEntry(raw);
        // First entry for an ID wins; IDs compare case-insensitively like in VS Code.
        if (entry && !seen.has(entry.id.toLowerCase())) {
          seen.add(entry.id.toLowerCase());
          tracking.push(entry);
        }
      } catch (err) {
        problems.push({
          message: `Invalid "leuchtturm.extensions" entry: ${(err as Error).message}`,
        });
      }
    }
  }

  return { settings, sources, tracking, problems };
}
