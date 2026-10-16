import { describe, expect, it } from 'vitest';

import { knownPaths, sectionsFor, type FieldSpec } from '../../src/sourceEditor/formSpec';
import { validateSource, type ValidationContext } from '../../src/sourceEditor/validate';
import { fromInput, getPath, sameSource, setPath, toText } from '../../src/sourceEditor/values';

const field = (kind: FieldSpec['kind'], extra: Partial<FieldSpec> = {}): FieldSpec => ({
  path: 'x',
  label: 'X',
  kind,
  ...extra,
});

describe('setPath / getPath', () => {
  it('creates and prunes nested objects', () => {
    let s = setPath({ type: 'http' }, 'index.url', 'https://a');
    expect(s).toEqual({ type: 'http', index: { url: 'https://a' } });
    expect(getPath(s, 'index.url')).toBe('https://a');
    s = setPath(s, 'index.url', undefined);
    expect(s).toEqual({ type: 'http' });
  });

  it('keeps unknown sibling fields', () => {
    const s = setPath({ index: { url: 'u', strictSSL: false } }, 'index.url', 'v');
    expect(s).toEqual({ index: { url: 'v', strictSSL: false } });
  });

  it('does not modify its input', () => {
    const original = { index: { url: 'u' } };
    setPath(original, 'index.url', 'v');
    expect(original).toEqual({ index: { url: 'u' } });
  });
});

describe('form values', () => {
  it('round-trips lists and maps as text', () => {
    expect(toText(field('list'), ['a', 'b'])).toBe('a\nb');
    expect(fromInput(field('list'), ' a \n\n b ')).toEqual(['a', 'b']);
    expect(fromInput(field('list'), '\n')).toBeUndefined();
    expect(toText(field('map'), { Accept: 'x', 'X-Token': '${secret:t}' })).toBe(
      'Accept: x\nX-Token: ${secret:t}',
    );
    expect(fromInput(field('map'), 'Accept: application/json\nurl: https://a:1/b')).toEqual({
      Accept: 'application/json',
      url: 'https://a:1/b',
    });
  });

  it('rejects malformed map lines and numbers', () => {
    expect(() => fromInput(field('map'), 'no colon')).toThrow(/key: value/);
    expect(() => fromInput(field('number'), 'abc')).toThrow(/positive number/);
    expect(fromInput(field('number'), '30')).toBe(30);
    expect(fromInput(field('number'), '')).toBeUndefined();
  });

  it('leaves defaults out', () => {
    expect(fromInput(field('boolean', { defaultValue: true }), true)).toBeUndefined();
    expect(fromInput(field('boolean', { defaultValue: true }), false)).toBe(false);
    expect(fromInput(field('select', { options: ['GET', 'POST'] }), 'GET')).toBeUndefined();
    expect(fromInput(field('select', { options: ['GET', 'POST'] }), 'POST')).toBe('POST');
    expect(fromInput(field('text'), '')).toBeUndefined();
  });

  it('compares sources independent of key order', () => {
    expect(sameSource({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameSource({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('formSpec', () => {
  it('has a General section with the common fields for every type', () => {
    for (const type of ['file', 'http', 'npm', 'script'] as const) {
      const sections = sectionsFor(type);
      expect(sections.at(-1)?.title).toBe('General');
      expect(knownPaths(type)).toContain('enabled');
    }
    expect(knownPaths('http')).toContain('match.jsonPath');
    // No credential or certificate fields anywhere: Leuchtturm handles no logins.
    for (const type of ['file', 'http', 'npm', 'script'] as const) {
      expect(knownPaths(type).filter((p) => /auth|ca$|strictSSL|npmrc|headers/.test(p))).toEqual(
        [],
      );
    }
  });
});

describe('validateSource', () => {
  const ctx: ValidationContext = {
    otherNames: ['share'],
    scriptEnabled: false,
    env: {},
  };

  it('accepts a complete file source', () => {
    expect(validateSource('corp', { type: 'file', path: '/tmp' }, ctx)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('checks the name', () => {
    expect(validateSource('', { type: 'file', path: '/x' }, ctx).errors).toEqual([
      'Give the source a name.',
    ]);
    expect(validateSource('a b', { type: 'file', path: '/x' }, ctx).errors[0]).toMatch(/letters/);
    expect(validateSource('share', { type: 'file', path: '/x' }, ctx).errors[0]).toMatch(
      /already a source named "share"/,
    );
  });

  it('reports what the real parser reports', () => {
    expect(validateSource('f', { type: 'file' }, ctx).errors).toEqual([
      '"path" is required for a file source',
    ]);
    expect(
      validateSource(
        'h',
        { type: 'http', index: { url: 'https://a' }, download: { url: 'https://a/${x}' } },
        ctx,
      ).errors,
    ).toEqual(['"match" is required: { "regex": … } or { "jsonPath": … }']);
  });

  it('validates disabled sources too, and says they are disabled', () => {
    const v = validateSource('f', { type: 'file', enabled: false }, ctx);
    expect(v.errors).toEqual(['"path" is required for a file source']);
    expect(v.warnings).toEqual(['This source is disabled and will not be checked.']);
  });

  it('reports credentials as not supported', () => {
    const v = validateSource(
      'n',
      { type: 'npm', scope: '@corp', auth: { token: '${secret:nexus}' } },
      ctx,
    );
    expect(v.errors).toEqual([expect.stringMatching(/"auth" is not supported/)]);
  });

  it('warns when scripts are turned off but still checks the fields', () => {
    const v = validateSource('s', { type: 'script', command: 'python3' }, ctx);
    expect(v.errors).toEqual([]);
    expect(v.warnings[0]).toMatch(/Script sources are turned off/);
    expect(validateSource('s', { type: 'script' }, ctx).errors).toEqual(['"command" is required']);
  });
});
