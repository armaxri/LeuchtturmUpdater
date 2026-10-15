/**
 * A small JSON Schema validator for the subset used by `schemas/script-protocol.schema.json`:
 * type, properties, required, additionalProperties, items, enum, const, pattern, minLength,
 * minItems, oneOf, anyOf and local `$ref`s (`#/$defs/name`). Enough to give script authors
 * precise error messages without a validation library.
 */

export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  minItems?: number;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  [key: string]: unknown;
};

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function resolve(root: JsonSchema, schema: JsonSchema): JsonSchema {
  let s = schema;
  for (let i = 0; s.$ref && i < 20; i++) {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    const target = m ? root.$defs?.[m[1]!] : undefined;
    if (!target) {
      throw new Error(`Unsupported $ref ${s.$ref}`);
    }
    s = target;
  }
  return s;
}

function at(path: string): string {
  return path === '' ? '(top level)' : path;
}

function validate(
  root: JsonSchema,
  schemaIn: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const schema = resolve(root, schemaIn);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${at(path)}: must be ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at(path)}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(
      `${at(path)}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`,
    );
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at(path)}: must not be empty`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      // A description reads better than the regex, e.g. "must be publisher.name".
      errors.push(
        typeof schema.description === 'string'
          ? `${at(path)}: "${value}" must be ${schema.description}`
          : `${at(path)}: "${value}" does not match ${schema.pattern}`,
      );
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at(path)}: needs at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, i) => validate(root, schema.items!, item, `${path}[${i}]`, errors));
    }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${at(path)}: missing required property "${key}"`);
      }
    }
    for (const [key, v] of Object.entries(obj)) {
      const child = path ? `${path}.${key}` : key;
      const prop = schema.properties?.[key];
      if (prop) {
        validate(root, prop, v, child, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at(path)}: unexpected property "${key}"`);
      } else if (typeof schema.additionalProperties === 'object') {
        validate(root, schema.additionalProperties, v, child, errors);
      }
    }
  }
  for (const [keyword, list] of [
    ['oneOf', schema.oneOf],
    ['anyOf', schema.anyOf],
  ] as const) {
    if (!list) {
      continue;
    }
    const results = list.map((s) => {
      const e: string[] = [];
      validate(root, s, value, path, e);
      return e;
    });
    const passing = results.filter((e) => e.length === 0).length;
    if (keyword === 'oneOf' ? passing !== 1 : passing === 0) {
      if (passing > 1) {
        errors.push(`${at(path)}: matches more than one allowed form`);
      } else {
        // Report the alternative that came closest (fewest errors).
        const best = results.reduce((a, b) => (b.length < a.length ? b : a));
        errors.push(...best);
      }
    }
  }
}

/** Validates `value` against `schema` (or one of its `$defs`). Returns error messages. */
export function validateJson(schema: JsonSchema, value: unknown, def?: string): string[] {
  const errors: string[] = [];
  validate(schema, def ? { $ref: `#/$defs/${def}` } : schema, value, '', errors);
  return errors;
}
