/**
 * A small JSONPath subset for the `http` source's `match.jsonPath`:
 *
 *   $                 the root
 *   .key  ['key']     a property
 *   [0]   [-1]        an array element (negative counts from the end)
 *   [*]   .*          every element / property value
 *   ..key             `key` at any depth below
 *
 * Each result keeps its ancestors, so the matcher can expose fields of enclosing objects
 * (e.g. a Jenkins build `number` next to the `fileName` of one of its artifacts).
 */

export interface JsonPathResult {
  value: unknown;
  /** Enclosing values, outermost first, excluding `value` itself. */
  ancestors: unknown[];
}

type Segment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'descend'; key: string };

export class JsonPathError extends Error {
  override name = 'JsonPathError';
}

/** Token patterns, tried in order. Each must match at the start of the remaining path. */
const TOKENS: [RegExp, (m: RegExpExecArray) => Segment][] = [
  [/^\.\.([A-Za-z_$][\w$-]*)/, (m) => ({ kind: 'descend', key: m[1]! })],
  [/^(?:\.\*|\[\*\])/, () => ({ kind: 'wildcard' })],
  [/^\.([A-Za-z_$][\w$-]*)/, (m) => ({ kind: 'key', key: m[1]! })],
  [/^\[(-?\d+)\]/, (m) => ({ kind: 'index', index: Number(m[1]) })],
  [/^\[\s*'([^']*)'\s*\]/, (m) => ({ kind: 'key', key: m[1]! })],
  [/^\[\s*"([^"]*)"\s*\]/, (m) => ({ kind: 'key', key: m[1]! })],
];

export function parseJsonPath(path: string): Segment[] {
  const p = path.trim();
  if (!p.startsWith('$')) {
    throw new JsonPathError(`JSONPath must start with "$": ${path}`);
  }
  const segments: Segment[] = [];
  let rest = p.slice(1);
  outer: while (rest.length > 0) {
    for (const [re, make] of TOKENS) {
      const m = re.exec(rest);
      if (m) {
        segments.push(make(m));
        rest = rest.slice(m[0].length);
        continue outer;
      }
    }
    throw new JsonPathError(`Unsupported JSONPath syntax at "${rest}" in ${path}`);
  }
  return segments;
}

function children(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value);
  }
  return [];
}

function descend(value: unknown, ancestors: unknown[], key: string, out: JsonPathResult[]): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (!Array.isArray(value) && Object.hasOwn(value, key)) {
    out.push({ value: (value as Record<string, unknown>)[key], ancestors: [...ancestors, value] });
  }
  for (const child of children(value)) {
    descend(child, [...ancestors, value], key, out);
  }
}

/** Evaluates `path` against `root`. Missing keys simply produce no results. */
export function queryJsonPath(root: unknown, path: string): JsonPathResult[] {
  let current: JsonPathResult[] = [{ value: root, ancestors: [] }];
  for (const seg of parseJsonPath(path)) {
    const next: JsonPathResult[] = [];
    for (const { value, ancestors } of current) {
      const up = [...ancestors, value];
      switch (seg.kind) {
        case 'key':
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            if (Object.hasOwn(value, seg.key)) {
              next.push({ value: (value as Record<string, unknown>)[seg.key], ancestors: up });
            }
          }
          break;
        case 'index':
          if (Array.isArray(value)) {
            const idx = seg.index < 0 ? value.length + seg.index : seg.index;
            if (idx >= 0 && idx < value.length) {
              next.push({ value: value[idx], ancestors: up });
            }
          }
          break;
        case 'wildcard':
          for (const child of children(value)) {
            next.push({ value: child, ancestors: up });
          }
          break;
        case 'descend':
          descend(value, ancestors, seg.key, next);
          break;
      }
    }
    current = next;
  }
  return current;
}
