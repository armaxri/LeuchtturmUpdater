/**
 * Config for the `http` source (SPEC §6.4): index request → matcher → download request.
 *
 * The index request and the auth header contain no per-version variables, so they are
 * expanded here once; errors become config problems. Download and release-notes templates
 * depend on the matched groups and are expanded per version later; here we only check that
 * every variable they use can exist.
 */

import { parseJsonPath } from '../util/jsonPath';
import { expandTemplate, findVariableNames, type TemplateContext } from '../util/template';
import {
  compileRegex,
  isObject,
  optionalString,
  parseAuth,
  parseTls,
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
  index: { url: string; method: string; headers: Record<string, string>; body?: string };
  match: HttpMatchConfig;
  /** Templates, expanded per version. */
  download: { url: string; headers: Record<string, string> };
  releaseNotesUrl?: string;
  /** Expanded `Authorization` value from `auth`, sent unless a request sets its own. */
  authorization?: string;
  strictSSL: boolean;
  /** Absolute path of an extra CA certificate (PEM). */
  caPath?: string;
  /** Context for expanding the per-version templates (secrets, env). */
  templateContext: TemplateContext;
  /** Derived credentials (e.g. the base64 basic-auth value) that logs must redact. */
  sensitiveValues: string[];
}

const METHODS = ['GET', 'POST', 'HEAD'];
/** Variables every per-version template may use besides the matched groups. */
const OPERATION_VARS = ['id', 'version', 'targetDir'];

function expandRecord(
  record: Record<string, string>,
  ctx: TemplateContext,
): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expandTemplate(v, ctx)]));
}

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
  if (!isObject(raw.index)) {
    throw new SourceConfigError('"index" is required: { "url": … }');
  }
  const method = (optionalString(raw.index.method, 'index.method') ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) {
    throw new SourceConfigError(`"index.method" must be one of ${METHODS.join(', ')}`);
  }
  const indexBody = optionalString(raw.index.body, 'index.body');
  const index = {
    url: expandTemplate(requiredString(raw.index.url, 'index.url'), ctx),
    method,
    headers: expandRecord(stringRecord(raw.index.headers, 'index.headers'), ctx),
    body: indexBody === undefined ? undefined : expandTemplate(indexBody, ctx),
  };
  const match = parseMatch(raw.match);

  if (!isObject(raw.download)) {
    throw new SourceConfigError('"download" is required: { "url": … }');
  }
  const download = {
    url: requiredString(raw.download.url, 'download.url'),
    headers: stringRecord(raw.download.headers, 'download.headers'),
  };
  const releaseNotesUrl = isObject(raw.releaseNotes)
    ? optionalString(raw.releaseNotes.url, 'releaseNotes.url')
    : undefined;
  checkTemplates(
    {
      'download.url': download.url,
      ...Object.fromEntries(
        Object.entries(download.headers).map(([k, v]) => [`download.headers.${k}`, v]),
      ),
      ...(releaseNotesUrl ? { 'releaseNotes.url': releaseNotesUrl } : {}),
    },
    match,
    ctx,
  );

  const { authorization, sensitive } = parseAuth(raw.auth, ctx);
  // `strictSSL` and `ca` may be set on the source or, as in older examples, on `index`.
  const tls = parseTls(
    { strictSSL: raw.strictSSL ?? raw.index.strictSSL, ca: raw.ca ?? raw.index.ca },
    ctx,
  );

  return {
    ...common,
    type: 'http',
    index,
    match,
    download,
    releaseNotesUrl,
    authorization,
    ...tls,
    templateContext: ctx,
    sensitiveValues: sensitive,
  };
}
