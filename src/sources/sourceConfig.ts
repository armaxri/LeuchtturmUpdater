/** Pieces shared by the per-type source config parsers (`fileConfig.ts`, `httpConfig.ts`, …). */

import { basicAuth } from '../util/http';
import { expandPath, expandTemplate, type TemplateContext } from '../util/template';
import type { SourceType } from './types';

export interface CommonSourceConfig {
  name: string;
  type: SourceType;
  /** Per-source timeout in seconds, if set. */
  timeoutSeconds?: number;
  include: string[];
  exclude: string[];
}

/** A user-facing configuration error for one source. Shown under "Problems". */
export class SourceConfigError extends Error {}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Validates an object of string values, e.g. HTTP headers. */
export function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isObject(value) || !Object.values(value).every((v) => typeof v === 'string')) {
    throw new SourceConfigError(`"${field}" must be an object with string values`);
  }
  return value as Record<string, string>;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new SourceConfigError(`"${field}" must be a string`);
  }
  return value;
}

export function requiredString(value: unknown, field: string): string {
  const s = optionalString(value, field);
  if (s === undefined || s.trim() === '') {
    throw new SourceConfigError(`"${field}" is required`);
  }
  return s;
}

/** Compiles a user regex, turning syntax errors into config errors. */
export function compileRegex(pattern: string, flags: string, field: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new SourceConfigError(`"${field}" is not a valid regex: ${(err as Error).message}`);
  }
}

/**
 * Names of the named groups in a regex. Probes with an alternative empty match, so the
 * pattern does not have to be parsed by hand: `groups` lists every group, matched or not.
 */
export function regexGroupNames(re: RegExp): string[] {
  const flags = re.flags.replace(/[gy]/g, '');
  return Object.keys(new RegExp(`${re.source}|(?<__probe>)`, flags).exec('')?.groups ?? {}).filter(
    (n) => n !== '__probe',
  );
}

/**
 * `auth`: `{ "basic": { "user", "password" } }`, `{ "bearer": "…" }` or (npm style)
 * `{ "token": "…" }`. Returns the expanded `Authorization` header value and the derived
 * values that logs must redact.
 */
export function parseAuth(
  raw: unknown,
  ctx: TemplateContext,
): { authorization?: string; sensitive: string[] } {
  if (raw === undefined) {
    return { sensitive: [] };
  }
  if (!isObject(raw)) {
    throw new SourceConfigError('"auth" must be an object');
  }
  if (isObject(raw.basic)) {
    const user = expandTemplate(requiredString(raw.basic.user, 'auth.basic.user'), ctx);
    const password = expandTemplate(requiredString(raw.basic.password, 'auth.basic.password'), ctx);
    const authorization = basicAuth(user, password);
    return { authorization, sensitive: [authorization.slice('Basic '.length), password] };
  }
  const bearer = raw.bearer ?? raw.token;
  if (typeof bearer === 'string') {
    const token = expandTemplate(bearer, ctx);
    return { authorization: `Bearer ${token}`, sensitive: [token] };
  }
  throw new SourceConfigError(
    '"auth" must be { "basic": { "user", "password" } }, { "bearer": "…" } or { "token": "…" }',
  );
}

export interface TlsConfig {
  strictSSL: boolean;
  /** Absolute path of an extra CA certificate (PEM). */
  caPath?: string;
}

export function parseTls(
  raw: { strictSSL?: unknown; ca?: unknown },
  ctx: TemplateContext,
): TlsConfig {
  if (raw.strictSSL !== undefined && typeof raw.strictSSL !== 'boolean') {
    throw new SourceConfigError('"strictSSL" must be true or false');
  }
  const ca = optionalString(raw.ca, 'ca');
  return { strictSSL: raw.strictSSL !== false, caPath: ca ? expandPath(ca, ctx) : undefined };
}
