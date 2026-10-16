/**
 * Config for the `http` source (SPEC §6.4): index request → matcher → download request.
 *
 * The index request contains no per-version variables, so it is expanded here once; errors
 * become config problems.
 *
 * There is deliberately no login support (no auth, no custom headers, no TLS options): servers
 * that need credentials are reached through a `script` source, which handles them itself. Download and release-notes templates
 * depend on the matched groups and are expanded per version later; here we only check that
 * every variable they use can exist.
 */

import { parseJsonPath } from '../util/jsonPath';
import { expandTemplate, findVariableNames, type TemplateContext } from '../util/template';
import {
  compileRegex,
  isObject,
  optionalString,
  regexGroupNames,
  requiredString,
  SourceConfigError,
  stringRecord,
  type CommonSourceConfig,
} from './sourceConfig';

export interface HttpMatchConfig {
  /** Always has the `g` flag. */
  regex?: RegExp;
  jsonPath?: string;
  /** jsonPath mode: the field the regex is applied to. */
  field?: string;
  /** Fixed artifact ID when the response does not contain one. */
  id?: string;
  /** Only keep matches whose groups/fields equal these values. */
  where: Record<string, string>;
}

export interface HttpSourceConfig extends CommonSourceConfig {
  type: 'http';
  index: { url: string; method: string; body?: string };
  match: HttpMatchConfig;
  /** Template, expanded per version. */
  download: { url: string };
  releaseNotesUrl?: string;
  /** Context for expanding the per-version templates (env). */
  templateContext: TemplateContext;
}

const METHODS = ['GET', 'POST', 'HEAD'];
/** Variables every per-version template may use besides the matched groups. */
const OPERATION_VARS = ['id', 'version', 'targetDir'];

/** Fields that were removed on purpose; they get a clear message instead of being ignored. */
const LOGIN_FIELDS = ['auth', 'ca', 'strictSSL'];

function parseMatch(raw: unknown): HttpMatchConfig {
  if (!isObject(raw)) {
    throw new SourceConfigError('"match" is required: { "regex": … } or { "jsonPath": … }');
  }
  const regexText = optionalString(raw.regex, 'match.regex');
  const jsonPath = optionalString(raw.jsonPath, 'match.jsonPath') || undefined;
  if (!regexText && !jsonPath) {
    throw new SourceConfigError('"match" needs a "regex", a "jsonPath", or both');
  }
  const flags = optionalString(raw.flags, 'match.flags') ?? 'g';
  if (!/^[gimsuy]*$/.test(flags)) {
    throw new SourceConfigError(`"match.flags" may only contain g, i, m, s, u, y`);
  }
  // Always global: we collect every match in the body.
  const regex = regexText
    ? compileRegex(regexText, flags.includes('g') ? flags : `${flags}g`, 'match.regex')
    : undefined;
  if (jsonPath) {
    try {
      parseJsonPath(jsonPath);
    } catch (err) {
      throw new SourceConfigError(`"match.jsonPath": ${(err as Error).message}`);
    }
  }
  const id = optionalString(raw.id, 'match.id') || undefined;
  if (regex && !jsonPath) {
    const groups = regexGroupNames(regex);
    const needed = id ? ['version'] : ['id', 'version'];
    for (const g of needed) {
      if (!groups.includes(g)) {
        throw new SourceConfigError(
          `"match.regex" must contain a named group (?<${g}>…)${g === 'id' ? ' or set "match.id"' : ''}`,
        );
      }
    }
  }
  return {
    regex,
    jsonPath,
    field: optionalString(raw.field, 'match.field') || undefined,
    id,
    where: stringRecord(raw.where, 'match.where'),
  };
}

/**
 * Checks that per-version templates only use variables that can exist: matched groups, the
 * operation variables, and env/secret values that are actually set. In jsonPath mode the
 * available fields are only known at runtime, so plain names are not checked.
 */
function checkTemplates(
  templates: Record<string, string>,
  match: HttpMatchConfig,
  ctx: TemplateContext,
): void {
  const groups = match.regex ? regexGroupNames(match.regex) : [];
  const known = new Set([...OPERATION_VARS, ...groups, 'userHome', 'platform']);
  for (const [field, template] of Object.entries(templates)) {
    for (const name of findVariableNames(template)) {
      if (name.startsWith('env:') || name.startsWith('secret:')) {
        expandTemplate(`\${${name}}`, ctx); // throws a helpful TemplateError if unset
      } else if (!match.jsonPath && !known.has(name)) {
        throw new SourceConfigError(
          `"${field}" uses \${${name}}, which is not a named group of "match.regex" ` +
            `(available: ${[...known].map((n) => `\${${n}}`).join(', ')})`,
        );
      }
    }
  }
}

export function parseHttpSource(
  common: CommonSourceConfig,
  raw: Record<string, unknown>,
  ctx: TemplateContext,
): HttpSourceConfig {
  rejectLoginFields(raw);
  if (!isObject(raw.index)) {
    throw new SourceConfigError('"index" is required: { "url": … }');
  }
  rejectLoginFields(raw.index, 'index.');
  const method = (optionalString(raw.index.method, 'index.method') ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) {
    throw new SourceConfigError(`"index.method" must be one of ${METHODS.join(', ')}`);
  }
  const indexBody = optionalString(raw.index.body, 'index.body');
  const index = {
    url: expandTemplate(requiredString(raw.index.url, 'index.url'), ctx),
    method,
    body: indexBody === undefined ? undefined : expandTemplate(indexBody, ctx),
  };
  const match = parseMatch(raw.match);

  if (!isObject(raw.download)) {
    throw new SourceConfigError('"download" is required: { "url": … }');
  }
  rejectLoginFields(raw.download, 'download.');
  const download = { url: requiredString(raw.download.url, 'download.url') };
  const releaseNotesUrl = isObject(raw.releaseNotes)
    ? optionalString(raw.releaseNotes.url, 'releaseNotes.url')
    : undefined;
  checkTemplates(
    {
      'download.url': download.url,
      ...(releaseNotesUrl ? { 'releaseNotes.url': releaseNotesUrl } : {}),
    },
    match,
    ctx,
  );

  return {
    ...common,
    type: 'http',
    index,
    match,
    download,
    releaseNotesUrl,
    templateContext: ctx,
  };
}

/**
 * Login and TLS settings are not supported: Leuchtturm does not handle credentials. Say so
 * clearly instead of silently sending requests without them.
 */
function rejectLoginFields(raw: Record<string, unknown>, prefix = ''): void {
  for (const field of [...LOGIN_FIELDS, 'headers']) {
    if (raw[field] !== undefined) {
      throw new SourceConfigError(
        `"${prefix}${field}" is not supported: Leuchtturm does not handle logins or ` +
          'certificates. For a server that needs a login, use a "script" source, which ' +
          'signs in itself (see docs/sources/script.md).',
      );
    }
  }
}
