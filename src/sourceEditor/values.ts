/**
 * Reading and writing form values in a source object. Pure functions, shared by the webview
 * and the extension. Setting a field to "nothing" (empty text, empty list, default boolean)
 * removes the key, and parents that become empty, so settings.json stays tidy.
 */

import type { AuthMode, FieldSpec } from './formSpec';

export type RawSource = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function getPath(obj: RawSource, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/** Returns a copy with `path` set; `undefined` removes the key and prunes empty parents. */
export function setPath(obj: RawSource, path: string, value: unknown): RawSource {
  const [key, ...rest] = path.split('.');
  const copy: RawSource = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) {
      delete copy[key!];
    } else {
      copy[key!] = value;
    }
    return copy;
  }
  const child = isObject(copy[key!]) ? (copy[key!] as RawSource) : {};
  const updated = setPath(child, rest.join('.'), value);
  if (Object.keys(updated).length === 0) {
    delete copy[key!];
  } else {
    copy[key!] = updated;
  }
  return copy;
}

/** The text an input shows for a stored value. */
export function toText(field: FieldSpec, value: unknown): string {
  switch (field.kind) {
    case 'list':
      return Array.isArray(value) ? value.map(String).join('\n') : '';
    case 'map':
      return isObject(value)
        ? Object.entries(value)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('\n')
        : '';
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/**
 * The value to store for an input's text (or checkbox state); `undefined` means "leave the
 * key out". Throws a message for text that cannot be stored (e.g. `abc` in a number field).
 */
export function fromInput(field: FieldSpec, input: string | boolean): unknown {
  if (field.kind === 'boolean') {
    return input === (field.defaultValue ?? false) ? undefined : input;
  }
  const text = String(input);
  switch (field.kind) {
    case 'list': {
      const items = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    case 'map': {
      const entries: [string, string][] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) {
          throw new Error(`${field.label}: write each line as "key: value"`);
        }
        entries.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
      }
      return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    case 'number': {
      if (!text.trim()) {
        return undefined;
      }
      const n = Number(text);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${field.label}: enter a positive number`);
      }
      return n;
    }
    case 'select':
      return text === '' || text === field.options?.[0] ? undefined : text;
    default:
      return text === '' ? undefined : text;
  }
}

/** Which credentials block a source uses. */
export function authMode(source: RawSource): AuthMode {
  const auth = source.auth;
  if (!isObject(auth)) {
    return 'none';
  }
  if (isObject(auth.basic)) {
    return 'basic';
  }
  if (typeof auth.token === 'string') {
    return 'token';
  }
  return typeof auth.bearer === 'string' ? 'bearer' : 'none';
}

/** Switches the credentials block, keeping values that still fit. */
export function setAuthMode(source: RawSource, mode: AuthMode): RawSource {
  const current = authMode(source);
  if (mode === current) {
    return source;
  }
  if (mode === 'none') {
    return setPath(source, 'auth', undefined);
  }
  if (mode === 'basic') {
    return setPath(source, 'auth', { basic: { user: '', password: '' } });
  }
  // bearer and token are the same header; carry the value over.
  const token = getPath(source, `auth.${current}`);
  return setPath(source, 'auth', { [mode]: typeof token === 'string' ? token : '' });
}

/** Stable JSON for "has this draft changed?" comparisons. */
export function sameSource(a: unknown, b: unknown): boolean {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : isObject(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}
