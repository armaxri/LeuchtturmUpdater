import { describe, expect, it } from 'vitest';

import { Redactor } from '../../src/util/redact';

describe('Redactor', () => {
  it('masks registered secrets', () => {
    const r = new Redactor();
    r.add('hunter2hunter2');
    r.add('ab'); // too short, ignored
    expect(r.redact('token=hunter2hunter2 ab')).toBe('token=*** ab');
  });

  it('masks auth headers', () => {
    const r = new Redactor();
    expect(r.redact('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic ***');
    expect(r.redact('{"authorization":"Bearer abc.def"}')).toBe('{"authorization":"Bearer ***"}');
    expect(r.redact('Proxy-Authorization=xyz')).toBe('Proxy-Authorization=***');
  });

  it('masks npm tokens and URL credentials', () => {
    const r = new Redactor();
    expect(r.redact('//nexus/:_authToken=npm_abc123')).toBe('//nexus/:_authToken=***');
    expect(r.redact('GET https://user:pa55@host.example/x')).toBe(
      'GET https://***:***@host.example/x',
    );
    expect(r.redact('https://host.example/user@x')).toBe('https://host.example/user@x');
  });
});
