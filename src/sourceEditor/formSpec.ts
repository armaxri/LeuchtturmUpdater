/**
 * What the source editor form shows for each source type. Plain data, shared by the extension
 * and the webview (which renders it generically). Field paths are dotted keys into the source
 * object as stored in `leuchtturm.sources`, e.g. `index.url` or `auth.basic.user`.
 *
 * Fields that the form does not know are kept as they are when saving, so hand-written settings
 * never lose anything by being opened in the editor.
 */

import type { SourceType } from '../sources/types';

export type FieldKind =
  /** One line of text. */
  | 'text'
  /** Text that may hold a password or token: offers stored credentials (`${secret:NAME}`). */
  | 'secret'
  | 'number'
  | 'boolean'
  | 'select'
  /** List of strings, one per line. */
  | 'list'
  /** String map, one `key: value` per line (headers, env, where). */
  | 'map';

export interface FieldSpec {
  path: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** For `select`. The first option is the default and is stored by leaving the field out. */
  options?: readonly string[];
  /** For `boolean`: the value that is stored by leaving the field out. */
  defaultValue?: boolean;
  /** Collapsed under "More options" until used. */
  advanced?: boolean;
}

/** How credentials are given: none, user and password, or a token. */
export type AuthMode = 'none' | 'basic' | 'bearer' | 'token';

export interface SectionSpec {
  title: string;
  help?: string;
  fields: readonly FieldSpec[];
  /** The `auth` block, rendered as a choice between the listed modes. */
  auth?: readonly AuthMode[];
}

export const TYPE_LABELS: Record<SourceType, string> = {
  file: 'File share or folder',
  http: 'Web server / Jenkins / Artifactory (HTTP)',
  npm: 'npm registry (Nexus, Artifactory, Verdaccio, …)',
  script: 'Your own script',
};

export const DOCS_URL = 'https://github.com/armaxri/LeuchtturmUpdater/blob/main/docs/sources';

const TLS_FIELDS: readonly FieldSpec[] = [
  {
    path: 'ca',
    label: 'Extra CA certificate',
    kind: 'text',
    placeholder: '~/certs/corp-root-ca.pem',
    help: 'PEM file of your company root certificate, for servers with an internal CA.',
    advanced: true,
  },
  {
    path: 'strictSSL',
    label: 'Check TLS certificates',
    kind: 'boolean',
    defaultValue: true,
    help: 'Turn off only for servers with a broken TLS setup; prefer the CA certificate above.',
    advanced: true,
  },
];

const COMMON_FIELDS: readonly FieldSpec[] = [
  {
    path: 'enabled',
    label: 'Enabled',
    kind: 'boolean',
    defaultValue: true,
    help: 'Disabled sources are kept in the settings but not checked.',
  },
  {
    path: 'include',
    label: 'Only these extensions',
    kind: 'list',
    placeholder: 'corp.*',
    help: 'Glob patterns on extension IDs, one per line. Empty: everything the source offers.',
    advanced: true,
  },
  {
    path: 'exclude',
    label: 'Never these extensions',
    kind: 'list',
    placeholder: 'corp.experimental-*',
    advanced: true,
  },
  {
    path: 'timeout',
    label: 'Timeout (seconds)',
    kind: 'number',
    help: 'Empty: the default from leuchtturm.http.timeout or leuchtturm.script.timeout.',
    advanced: true,
  },
];

export const TYPE_SECTIONS: Record<SourceType, readonly SectionSpec[]> = {
  file: [
    {
      title: 'Location',
      fields: [
        {
          path: 'path',
          label: 'Folder',
          kind: 'text',
          required: true,
          placeholder: '\\\\fileserver\\tools\\vscode  or  /Volumes/tools/vscode',
          help: 'Folder or network share with .vsix files. ~ and ${env:NAME} work.',
        },
        {
          path: 'recursive',
          label: 'Include sub-folders',
          kind: 'boolean',
          defaultValue: false,
        },
        {
          path: 'filePattern',
          label: 'File name pattern',
          kind: 'text',
          placeholder: 'default: <publisher.name>-<version>.vsix',
          help: 'Regex with named groups (?<id>…) and (?<version>…). Leave empty for the default.',
          advanced: true,
        },
      ],
    },
  ],
  http: [
    {
      title: '1. Index: the page that lists the versions',
      fields: [
        {
          path: 'index.url',
          label: 'URL',
          kind: 'text',
          required: true,
          placeholder: 'https://jenkins.corp.example/job/corp-linter/api/json?tree=…',
        },
        {
          path: 'index.method',
          label: 'Method',
          kind: 'select',
          options: ['GET', 'POST', 'HEAD'],
          advanced: true,
        },
        {
          path: 'index.headers',
          label: 'Headers',
          kind: 'map',
          placeholder: 'Accept: application/json',
          advanced: true,
        },
        { path: 'index.body', label: 'Request body', kind: 'text', advanced: true },
      ],
    },
    {
      title: '2. Match: find versions in the response',
      help: 'Use a JSONPath for JSON APIs, a regex for HTML pages, or both. Every named group becomes a ${variable} for the download URL.',
      fields: [
        {
          path: 'match.jsonPath',
          label: 'JSONPath',
          kind: 'text',
          placeholder: '$.builds[*].artifacts[*]',
        },
        {
          path: 'match.field',
          label: 'Field the regex runs on',
          kind: 'text',
          placeholder: 'fileName',
          help: 'JSONPath mode only.',
        },
        {
          path: 'match.regex',
          label: 'Regex',
          kind: 'text',
          placeholder: '^(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix$',
          help: 'Named groups: (?<version>…) is required, (?<id>…) unless the fixed ID is set.',
        },
        {
          path: 'match.where',
          label: 'Only where',
          kind: 'map',
          placeholder: 'result: SUCCESS',
          help: 'Keep only matches whose fields have these values.',
        },
        {
          path: 'match.id',
          label: 'Fixed extension ID',
          kind: 'text',
          placeholder: 'corp.linter',
          help: 'For listings that contain only versions.',
          advanced: true,
        },
        {
          path: 'match.flags',
          label: 'Regex flags',
          kind: 'text',
          placeholder: 'g',
          advanced: true,
        },
      ],
    },
    {
      title: '3. Download',
      fields: [
        {
          path: 'download.url',
          label: 'URL',
          kind: 'text',
          required: true,
          placeholder:
            'https://jenkins.corp.example/job/corp-linter/${number}/artifact/${relativePath}',
          help: 'Matched groups, ${id} and ${version} are available.',
        },
        {
          path: 'download.headers',
          label: 'Headers',
          kind: 'map',
          advanced: true,
        },
        {
          path: 'releaseNotes.url',
          label: 'Release notes URL',
          kind: 'text',
          placeholder:
            'https://jenkins.corp.example/job/corp-linter/${number}/artifact/CHANGELOG.md',
          advanced: true,
        },
      ],
    },
    { title: 'Credentials', fields: TLS_FIELDS, auth: ['none', 'basic', 'bearer'] },
  ],
  npm: [
    {
      title: 'Registry',
      fields: [
        {
          path: 'registry',
          label: 'Registry URL',
          kind: 'text',
          required: true,
          placeholder: 'https://nexus.corp.example/repository/npm-internal/',
        },
        {
          path: 'scope',
          label: 'Scope',
          kind: 'text',
          placeholder: '@corp-vscode',
          help: 'Lists every package of this scope. Set this or the package names.',
        },
        {
          path: 'packages',
          label: 'Package names',
          kind: 'list',
          placeholder: '@corp-vscode/linter',
          help: 'For registries without a search API. Used instead of the scope when set.',
        },
      ],
    },
    {
      title: 'Credentials',
      help: 'Without credentials here, Leuchtturm reads them from your .npmrc, like npm does.',
      auth: ['none', 'token', 'basic'],
      fields: [
        {
          path: 'npmrc',
          label: '.npmrc file',
          kind: 'text',
          placeholder: '~/.npmrc',
          advanced: true,
        },
        ...TLS_FIELDS,
      ],
    },
  ],
  script: [
    {
      title: 'Program',
      help: 'Runs without a shell. Needs leuchtturm.script.enabled in your user settings and a one-time approval.',
      fields: [
        {
          path: 'command',
          label: 'Command',
          kind: 'text',
          required: true,
          placeholder: 'python3   (Windows: py)',
        },
        {
          path: 'script',
          label: 'Script file',
          kind: 'text',
          placeholder: '~/tools/leuchtturm_source.py',
          help: 'Passed as the first argument.',
        },
        {
          path: 'env',
          label: 'Environment',
          kind: 'map',
          placeholder: 'JENKINS_TOKEN: ${secret:jenkins}',
          help: 'Values support ${env:NAME} and ${secret:NAME}.',
        },
        { path: 'cwd', label: 'Working folder', kind: 'text', advanced: true },
        {
          path: 'args.list',
          label: 'Arguments: list',
          kind: 'list',
          placeholder: 'get_versions',
          advanced: true,
        },
        {
          path: 'args.download',
          label: 'Arguments: download',
          kind: 'list',
          placeholder: 'download_version',
          advanced: true,
        },
        {
          path: 'args.notes',
          label: 'Arguments: notes',
          kind: 'list',
          placeholder: 'get_release_notes',
          advanced: true,
        },
      ],
    },
  ],
};

/** All sections of a type, including the settings every source has. */
export function sectionsFor(type: SourceType): readonly SectionSpec[] {
  return [...TYPE_SECTIONS[type], { title: 'General', fields: COMMON_FIELDS }];
}

/** Field paths the form edits for a type (used to tell known from unknown fields). */
export function knownPaths(type: SourceType): string[] {
  const paths = ['type'];
  for (const section of sectionsFor(type)) {
    paths.push(...section.fields.map((f) => f.path));
    if (section.auth) {
      paths.push('auth');
    }
  }
  return paths;
}

/** Valid source names: they become `${…}`-free keys in settings.json and appear in the tree. */
export const SOURCE_NAME = /^[\w.-]+$/;
