import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach } from 'vitest';

const created: string[] = [];

/** A fresh temp directory, removed after each test. */
export async function tempDir(prefix = 'leuchtturm-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Creates files (relative path → content) below `root`. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/** A settings accessor backed by a plain object, like `readRawSettings()`. */
export function settings(values: Record<string, unknown>): (key: string) => unknown {
  return (key) => values[key];
}
