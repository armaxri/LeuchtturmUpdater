import { describe, expect, it } from 'vitest';

import { imageLinks, imageProblem } from '../../src/test/checkPackage';

describe('imageLinks', () => {
  it('finds Markdown and HTML images, not plain links', () => {
    const md = [
      '![Sidebar](docs/images/sidebar.png)',
      '![With title](./docs/a.png "A")',
      '[not an image](docs/configuration.md)',
      '<img alt="x" src="https://example.com/b.png" width="200">',
    ].join('\n');
    expect(imageLinks(md)).toEqual([
      'docs/images/sidebar.png',
      './docs/a.png',
      'https://example.com/b.png',
    ]);
  });
});

describe('imageProblem', () => {
  it('accepts only https images', () => {
    expect(imageProblem('https://github.com/a/b/raw/HEAD/x.png')).toBeUndefined();
    expect(imageProblem('http://example.com/x.png')).toMatch(/https/);
    expect(imageProblem('docs/images/x.png')).toMatch(/not an https URL/);
    expect(imageProblem('data:image/png;base64,AAAA')).toMatch(/not an https URL/);
  });
});
