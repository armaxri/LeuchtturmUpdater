import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT } from '../../src/test/paths';
import { validateJson, type JsonSchema } from '../../src/util/jsonSchema';

const schema = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'schemas/script-protocol.schema.json'), 'utf8'),
) as JsonSchema;

describe('script protocol schema', () => {
  it('accepts the documented responses', () => {
    expect(
      validateJson(
        schema,
        {
          protocol: 1,
          artifacts: [
            {
              id: 'corp.linter',
              displayName: 'Corp Linter',
              versions: [
                {
                  version: '1.4.1',
                  releaseNotes: '- Fix',
                  sha256: 'a'.repeat(64),
                  ref: { build: '312' },
                },
                { version: '1.4.0', ref: { build: '298' } },
              ],
            },
          ],
        },
        'list',
      ),
    ).toEqual([]);
    expect(validateJson(schema, { protocol: 1, path: '/tmp/x.vsix' }, 'download')).toEqual([]);
    expect(validateJson(schema, { protocol: 1, url: 'https://x/y.vsix' }, 'download')).toEqual([]);
    expect(validateJson(schema, { protocol: 1, markdown: '## x' }, 'notes')).toEqual([]);
    expect(validateJson(schema, { protocol: 1, error: 'down', detail: 'x' }, 'error')).toEqual([]);
  });

  it('explains what is wrong, with a path', () => {
    expect(
      validateJson(
        schema,
        {
          protocol: 2,
          artifacts: [{ id: 'nodot', versions: [{ version: '1.0', ref: { n: 1 } }], extra: true }],
        },
        'list',
      ),
    ).toEqual([
      'protocol: must be 1',
      'artifacts[0].id: "nodot" must be publisher.name',
      'artifacts[0].versions[0].version: "1.0" must be a semver version such as 1.4.1 or 2.0.0-beta.1',
      'artifacts[0].versions[0].ref.n: must be string, got integer',
      'artifacts[0]: unexpected property "extra"',
    ]);
    expect(validateJson(schema, { protocol: 1 }, 'download')).toEqual([
      '(top level): missing required property "path"',
    ]);
    expect(validateJson(schema, { protocol: 1, url: 'ftp://x' }, 'download')[0]).toMatch(
      /url: "ftp:\/\/x" must be an http:\/\/ or https:\/\/ URL/,
    );
    expect(validateJson(schema, [], 'list')).toEqual(['(top level): must be object, got array']);
  });
});

describe('docs/sources/script.md', () => {
  it('documents every field of the protocol schema', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/sources/script.md'), 'utf8');
    const names = new Set<string>();
    const walk = (s: unknown): void => {
      if (s && typeof s === 'object') {
        const props = (s as { properties?: Record<string, unknown> }).properties;
        Object.keys(props ?? {}).forEach((k) => names.add(k));
        Object.values(s).forEach(walk);
      }
    };
    walk(schema);
    const missing = [...names].filter((n) => !doc.includes(n));
    expect(missing).toEqual([]);
  });
});
