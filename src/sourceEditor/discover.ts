/**
 * "Paste a link" setup: turns what a user has at hand (a Jenkins page, a web page with .vsix
 * links, a folder, an npm package name) into a working source configuration.
 *
 * It recognises what the input is, proposes a configuration, and then lists it with the real
 * source code (`deps.list`), so the preview shows exactly what a check will find later. The
 * user never has to write a regex or a JSONPath; those are generated here.
 *
 * Servers that need a login are reported as such: Leuchtturm does not handle credentials, and
 * a `script` source is the way to reach them.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_FILE_PATTERN } from '../sources/fileConfig';
import type { Artifact } from '../sources/types';
import { NEVER_CANCELLED } from '../util/cancellation';
import { httpDownload, HttpError, httpRequest } from '../util/http';
import { readVsixManifest } from '../util/vsix';
import { compareVersions } from '../version';
import type { Discovery, FoundExtension } from './protocol';
import type { RawSource } from './values';

export interface DiscoverDeps {
  /** Lists a candidate source with the real implementation; throws what a check would show. */
  list(name: string, source: RawSource): Promise<Artifact[]>;
  timeoutMs?: number;
}

/** How many Jenkins builds are looked at: enough history to install older versions. */
export const JENKINS_BUILDS = 20;

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
/** `publisher.name-1.2.3.vsix`, as `vsce package` names files. */
const VSCE_NAME = new RegExp(DEFAULT_FILE_PATTERN, 'i');
/** `name-1.2.3.vsix`: a version, but no publisher. */
const VERSIONED_NAME = new RegExp(`^(?<base>.+?)-(?<version>${SEMVER})\\.vsix$`, 'i');

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A source name from free text: letters, digits, `-`, `_`, `.`. */
export function suggestName(text: string): string {
  const name = text
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return name.slice(0, 40) || 'source';
}

export type FileNaming =
  /** `publisher.name-1.2.3.vsix`: everything comes from the file name. */
  | { kind: 'vsce'; regex: string }
  /** `name-1.2.3.vsix`: the version comes from the name, the ID from inside the .vsix. */
  | { kind: 'versioned'; base: string; regex: string }
  | { kind: 'unusable'; message: string };

/**
 * Decides how versions can be read from the file names found. The regex has the named groups
 * the http matcher needs (`id`/`version`) and is anchored to the whole file name.
 */
export function analyseFileNames(names: readonly string[]): FileNaming {
  if (names.length === 0) {
    return { kind: 'unusable', message: 'No .vsix files found.' };
  }
  if (names.every((n) => VSCE_NAME.test(n))) {
    return { kind: 'vsce', regex: DEFAULT_FILE_PATTERN };
  }
  const versioned = names.map((n) => VERSIONED_NAME.exec(n)?.groups);
  if (versioned.every((g) => g !== undefined)) {
    const bases = [...new Set(versioned.map((g) => g!.base))];
    if (bases.length === 1) {
      return {
        kind: 'versioned',
        base: bases[0]!,
        regex: `^${escapeRegex(bases[0]!)}-(?<version>${SEMVER})\\.vsix$`,
      };
    }
    return {
      kind: 'unusable',
      message:
        `The files are named like "${names[0]}", without the publisher, and belong to ` +
        `${bases.length} different extensions. Leuchtturm can only tell them apart when the ` +
        'files are named like "publisher.name-1.2.3.vsix", as "vsce package" names them.',
    };
  }
  const example = names.find((_, i) => versioned[i] === undefined) ?? names[0]!;
  return {
    kind: 'unusable',
    message:
      `The file name "${example}" contains no version number, so Leuchtturm cannot tell ` +
      'versions apart. Name the files like "publisher.name-1.2.3.vsix" (what "vsce package" ' +
      'produces), for example by archiving the output of "vsce package" in the build.',
  };
}

function found(
  what: string,
  name: string,
  source: RawSource,
  artifacts: Artifact[],
  notes: string[],
): Discovery {
  const extensions: FoundExtension[] = artifacts
    .map((a) => ({
      id: a.id,
      displayName: a.displayName,
      versions: a.versions.map((v) => v.version).sort((x, y) => compareVersions(y, x)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (extensions.length === 0) {
    return {
      kind: 'problem',
      message: `${what}: no extensions found.`,
      hints: notes,
    };
  }
  return { kind: 'found', what, name: suggestName(name), source, extensions, notes };
}

const LOGIN: Omit<Extract<Discovery, { kind: 'login' }>, 'what'> = {
  kind: 'login',
  message:
    'This server asks for a login. Leuchtturm does not handle logins or passwords. Ask ' +
    'whoever runs the server for a script that signs in and lists the extensions (or write ' +
    'one); Leuchtturm runs it as a "script" source.',
};

/** Fetches a page; maps "needs a login" to `undefined`. */
async function fetchPage(url: string, timeoutMs: number) {
  try {
    const res = await httpRequest(url, { timeoutMs, token: NEVER_CANCELLED });
    // Jenkins and others redirect anonymous users to a login page.
    if (
      /\/login\b|[?&](?:from|returnto|redirect)=/i.test(
        new URL(res.url).pathname + new URL(res.url).search,
      )
    ) {
      return undefined;
    }
    return res;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return undefined;
    }
    throw err;
  }
}

/** Reads the extension ID from inside one .vsix (for file names without a publisher). */
async function vsixId(url: string, timeoutMs: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-discover-'));
  try {
    const file = path.join(dir, 'probe.vsix');
    await httpDownload(url, file, { timeoutMs: timeoutMs * 10, token: NEVER_CANCELLED });
    return (await readVsixManifest(file)).id;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// --- Jenkins ------------------------------------------------------------------------------

/** `…/job/a/job/b/lastSuccessfulBuild/artifact/x.vsix` → `…/job/a/job/b/`. */
export function jenkinsJobUrl(input: URL): URL | undefined {
  const parts = input.pathname.split('/');
  let end = -1;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'job' && parts[i + 1]) {
      end = i + 1;
    }
  }
  if (end < 0) {
    return undefined;
  }
  return new URL(`${parts.slice(0, end + 1).join('/')}/`, input.origin);
}

interface JenkinsBuilds {
  _class?: string;
  builds?: {
    number?: number;
    result?: string | null;
    artifacts?: { fileName?: string; relativePath?: string }[];
  }[];
}

async function discoverJenkins(job: URL, deps: Required<DiscoverDeps>): Promise<Discovery> {
  const jobName = decodeURIComponent(job.pathname.split('/').filter(Boolean).at(-1) ?? 'jenkins');
  const what = `Jenkins job "${jobName}"`;
  const api = `${job.href}api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,${JENKINS_BUILDS}}`;
  const res = await fetchPage(api, deps.timeoutMs);
  if (!res) {
    return { ...LOGIN, what };
  }
  let data: JenkinsBuilds;
  try {
    data = JSON.parse(res.body.toString('utf8')) as JenkinsBuilds;
  } catch {
    return {
      kind: 'problem',
      message: `${job.href} does not look like a Jenkins job (its API answered with no JSON).`,
      hints: ['Paste the link of the job page or of its "Last Successful Artifacts".'],
    };
  }
  const successful = (data.builds ?? []).filter((b) => b.result === 'SUCCESS');
  const vsix = successful.flatMap((b) =>
    (b.artifacts ?? []).filter((a) => a.fileName?.toLowerCase().endsWith('.vsix')),
  );
  if (vsix.length === 0) {
    return {
      kind: 'problem',
      message: `${what}: none of the last ${JENKINS_BUILDS} successful builds archived a .vsix file.`,
      hints: [
        'Archive the .vsix in the job ("Archive the artifacts" with e.g. "*.vsix").',
        `Builds looked at: ${successful.length} successful of ${data.builds?.length ?? 0}.`,
      ],
    };
  }
  const naming = analyseFileNames([...new Set(vsix.map((a) => a.fileName!))]);
  if (naming.kind === 'unusable') {
    return { kind: 'problem', message: `${what}: ${naming.message}`, hints: [] };
  }
  const match: Record<string, unknown> = {
    jsonPath: '$.builds[*].artifacts[*]',
    where: { result: 'SUCCESS' },
    field: 'fileName',
    regex: naming.regex,
  };
  const notes = [
    `Looks at the last ${JENKINS_BUILDS} builds of the job and uses the successful ones, so ` +
      'older versions can be installed too.',
  ];
  if (naming.kind === 'versioned') {
    const newest = successful.find((b) => b.artifacts?.some((a) => a.fileName?.endsWith('.vsix')))!;
    const artifact = newest.artifacts!.find((a) => a.fileName?.endsWith('.vsix'))!;
    match.id = await vsixId(
      `${job.href}${newest.number}/artifact/${artifact.relativePath}`,
      deps.timeoutMs,
    );
    notes.push(
      `The file names contain no publisher; the extension ID ${String(match.id)} was read from inside the newest .vsix.`,
    );
  }
  const source: RawSource = {
    type: 'http',
    index: { url: api },
    match,
    download: { url: `${job.href}\${number}/artifact/\${relativePath}` },
  };
  return found(what, jobName, source, await deps.list(jobName, source), notes);
}

// --- Web page with .vsix links ------------------------------------------------------------

async function discoverWebPage(input: URL, deps: Required<DiscoverDeps>): Promise<Discovery> {
  // A link to one .vsix: look at the page (folder) it is in.
  const page = input.pathname.toLowerCase().endsWith('.vsix') ? new URL('./', input) : input;
  const what = `the page ${page.href}`;
  const res = await fetchPage(page.href, deps.timeoutMs);
  if (!res) {
    return { ...LOGIN, what };
  }
  const html = res.body.toString('utf8');
  const hrefs = [
    ...new Set([...html.matchAll(/href\s*=\s*["']([^"'#?]+\.vsix)["']/gi)].map((m) => m[1]!)),
  ];
  if (hrefs.length === 0) {
    return {
      kind: 'problem',
      message: `No links to .vsix files on ${page.href}.`,
      hints: [
        'Paste the page that lists the .vsix files (a folder listing or a download page).',
        'For an npm registry, enter the package name instead, e.g. @corp/linter.',
      ],
    };
  }
  const files = hrefs.map((h) => decodeURIComponent(h.split('/').at(-1)!));
  const naming = analyseFileNames([...new Set(files)]);
  if (naming.kind === 'unusable') {
    return { kind: 'problem', message: `${what}: ${naming.message}`, hints: [] };
  }
  // The download URL is a fixed prefix plus the link as written on the page.
  const base = new URL(res.url);
  const absolute = hrefs.every((h) => /^https?:\/\//i.test(h));
  const prefix = absolute ? '' : hrefs[0]!.startsWith('/') ? base.origin : new URL('./', base).href;
  if (!absolute && !hrefs.every((h) => new URL(h, base).href === `${prefix}${h}`)) {
    return {
      kind: 'problem',
      message: `${what}: the .vsix links point to different places, which the guided setup cannot express.`,
      hints: ['Adjust the source by hand with "Set up manually".'],
    };
  }
  // The file name pattern without its anchors, placed at the end of the link.
  const fileRegex = naming.regex.replace(/^\^/, '').replace(/\$$/, '');
  const regex = `href\\s*=\\s*["'](?<file>(?:[^"']*/)?${fileRegex})["']`;
  const match: Record<string, unknown> = { regex };
  const notes = ['Leuchtturm reads this page on every check and installs from the links on it.'];
  if (naming.kind === 'versioned') {
    match.id = await vsixId(new URL(hrefs[0]!, base).href, deps.timeoutMs);
    notes.push(
      `The file names contain no publisher; the extension ID ${String(match.id)} was read from inside the .vsix.`,
    );
  }
  const source: RawSource = {
    type: 'http',
    index: { url: page.href },
    match,
    download: { url: `${prefix}\${file}` },
  };
  const name = page.pathname.split('/').filter(Boolean).at(-1) ?? page.hostname;
  return found(what, name, source, await deps.list(suggestName(name), source), notes);
}

// --- Folder --------------------------------------------------------------------------------

export function looksLikePath(input: string): boolean {
  return /^(?:~|\/|\\\\|[A-Za-z]:[\\/]|file:)/.test(input);
}

async function discoverFolder(input: string, deps: Required<DiscoverDeps>): Promise<Discovery> {
  let folder = input.startsWith('file:') ? new URL(input).pathname : input;
  folder = folder.replace(/^~(?=$|[\\/])/, os.homedir());
  let stat;
  try {
    stat = await fs.stat(folder);
  } catch {
    return {
      kind: 'problem',
      message: `The folder ${folder} does not exist or cannot be opened.`,
      hints: ['Check the path; network shares must be reachable (and mounted on macOS/Linux).'],
    };
  }
  if (stat.isFile()) {
    folder = path.dirname(folder);
  }
  const what = `the folder ${folder}`;
  const name = path.basename(folder) || 'share';
  const flat: RawSource = { type: 'file', path: folder };
  let artifacts = await deps.list(suggestName(name), flat);
  if (artifacts.length > 0) {
    return found(what, name, flat, artifacts, []);
  }
  const deep: RawSource = { ...flat, recursive: true };
  artifacts = await deps.list(suggestName(name), deep);
  if (artifacts.length > 0) {
    return found(what, name, deep, artifacts, [
      'The .vsix files are in sub-folders, which are searched too.',
    ]);
  }
  const entries = await fs.readdir(folder).catch(() => [] as string[]);
  const vsix = entries.filter((e) => e.toLowerCase().endsWith('.vsix'));
  const naming = analyseFileNames(vsix);
  return {
    kind: 'problem',
    message:
      vsix.length === 0
        ? `No .vsix files in ${folder} or its sub-folders.`
        : `${what}: ${naming.kind === 'unusable' ? naming.message : 'the .vsix files could not be read.'}`,
    hints: [],
  };
}

// --- npm -----------------------------------------------------------------------------------

const NPM_SPEC =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*(?:\/[a-z0-9-~][a-z0-9-._~]*)?|[a-z0-9-~][a-z0-9-._~]*)$/;

async function discoverNpm(input: string, deps: Required<DiscoverDeps>): Promise<Discovery> {
  const isScope = !input.includes('/');
  const source: RawSource =
    isScope && input.startsWith('@')
      ? { type: 'npm', scope: input }
      : { type: 'npm', packages: [input] };
  const what =
    isScope && input.startsWith('@') ? `the npm scope ${input}` : `the npm package ${input}`;
  try {
    const artifacts = await deps.list(suggestName(input.replace(/^@/, '')), source);
    return found(what, input.replace(/^@/, ''), source, artifacts, [
      'Leuchtturm runs your npm for this, so it uses your npm configuration (registry, login).',
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hints = /E40[13]|ENEEDAUTH|auth/i.test(message)
      ? ['npm needs a login for this registry. Log in with npm itself (npm login), then try again.']
      : /E404|not found/i.test(message)
        ? [
            'Check the name. If the package is on a company registry, configure that registry for npm (in .npmrc), then try again.',
          ]
        : [];
    return { kind: 'problem', message: `${what}: ${message}`, hints };
  }
}

// --- Entry point ---------------------------------------------------------------------------

/** Recognises what `input` is and proposes a working source for it. Never throws. */
export async function discover(rawInput: string, deps: DiscoverDeps): Promise<Discovery> {
  const input = rawInput.trim().replace(/^<|>$/g, '');
  const full = { timeoutMs: 30_000, ...deps };
  try {
    if (!input) {
      return {
        kind: 'problem',
        message: 'Paste a link, a folder or an npm package name.',
        hints: [],
      };
    }
    if (looksLikePath(input)) {
      return await discoverFolder(input, full);
    }
    if (/^https?:\/\//i.test(input)) {
      const url = new URL(input);
      const job = jenkinsJobUrl(url);
      return job ? await discoverJenkins(job, full) : await discoverWebPage(url, full);
    }
    if (NPM_SPEC.test(input)) {
      return await discoverNpm(input, full);
    }
    return {
      kind: 'problem',
      message: `"${input}" is not a link, a folder or an npm package name.`,
      hints: [
        'Links start with https:// or http://. Folders start with / or ~ (or C:\\, \\\\server on Windows).',
      ],
    };
  } catch (err) {
    return {
      kind: 'problem',
      message: err instanceof Error ? err.message : String(err),
      hints: ['Check that the address is right and reachable from this computer.'],
    };
  }
}
