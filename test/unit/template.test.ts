import { describe, expect, it } from 'vitest';

import {
  expandPath,
  expandTemplate,
  findSecretNames,
  TemplateError,
} from '../../src/util/template';

describe('expandTemplate', () => {
  const ctx = {
    vars: { id: 'corp.linter', version: '1.4.1', empty: '' },
    ref: { build: '312' },
    env: { TOKEN: 'abc' },
    secrets: { jenkins: 's3cret' },
    userHome: '/home/me',
    platform: 'linux-x64',
  };

  it('substitutes every variable kind', () => {
    expect(
      expandTemplate(
        '${id}-${version}/${ref.build}?t=${env:TOKEN}&s=${secret:jenkins}&h=${userHome}&p=${platform}&e=${empty}',
        ctx,
      ),
    ).toBe('corp.linter-1.4.1/312?t=abc&s=s3cret&h=/home/me&p=linux-x64&e=');
  });

  it('leaves text without variables untouched', () => {
    expect(expandTemplate('plain $text {id}', ctx)).toBe('plain $text {id}');
  });

  it('throws on unknown or unset variables instead of substituting ""', () => {
    expect(() => expandTemplate('${nope}', ctx)).toThrow(TemplateError);
    expect(() => expandTemplate('${env:MISSING}', ctx)).toThrow(/MISSING/);
    expect(() => expandTemplate('${secret:other}', ctx)).toThrow(/Store Credential/);
    expect(() => expandTemplate('${ref.missing}', ctx)).toThrow(TemplateError);
    expect(() => expandTemplate('${constructor}', ctx)).toThrow(TemplateError);
  });

  it('defaults env to process.env', () => {
    process.env.LEUCHTTURM_TEST_VAR = 'from-env';
    expect(expandTemplate('${env:LEUCHTTURM_TEST_VAR}')).toBe('from-env');
    delete process.env.LEUCHTTURM_TEST_VAR;
  });
});

describe('expandPath', () => {
  it('expands a leading ~ only', () => {
    expect(expandPath('~/vsix', { userHome: '/home/me' })).toBe('/home/me/vsix');
    expect(expandPath('~\\vsix', { userHome: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\vsix');
    expect(expandPath('~', { userHome: '/home/me' })).toBe('/home/me');
    expect(expandPath('/a/~/b', { userHome: '/home/me' })).toBe('/a/~/b');
    expect(expandPath('~other/x', { userHome: '/home/me' })).toBe('~other/x');
  });
});

describe('findSecretNames', () => {
  it('collects unique secret names', () => {
    expect(findSecretNames('Basic ${secret:a}', '${secret:b} ${secret:a}', '${env:c}')).toEqual([
      'a',
      'b',
    ]);
  });
});
