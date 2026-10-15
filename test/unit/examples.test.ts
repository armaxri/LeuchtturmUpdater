/** Every example settings snippet must load without problems, so the docs cannot go stale. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConfig, referencedSecrets } from '../../src/config';
import { ROOT } from '../../src/test/paths';
import { findVariableNames } from '../../src/util/template';

/** Minimal JSONC → JSON: drops `//` comments outside strings and trailing commas. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

const dir = path.join(ROOT, 'examples/settings');

describe('examples/settings', () => {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonc'))) {
    it(`${file} is valid`, () => {
      const json = parseJsonc(fs.readFileSync(path.join(dir, file), 'utf8'));
      const sources = json['leuchtturm.sources'];
      const secrets = Object.fromEntries(referencedSecrets(sources).map((n) => [n, 'x']));
      const env = Object.fromEntries(
        findVariableNames(JSON.stringify(sources))
          .filter((n) => n.startsWith('env:'))
          .map((n) => [n.slice(4), '/x']),
      );
      const config = parseConfig((key) => json[`leuchtturm.${key}`], {
        secrets,
        env,
        userHome: '/home/me',
      });
      expect(config.problems).toEqual([]);
      expect(config.sources.length).toBeGreaterThan(0);
    });
  }
});
