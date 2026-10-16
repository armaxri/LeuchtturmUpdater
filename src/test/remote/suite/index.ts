/** Mocha entry point for the Dev Containers test (loaded by VS Code, like ../integration). */

import * as fs from 'node:fs';
import * as path from 'node:path';

import Mocha from 'mocha';

export function run(): Promise<void> {
  // Starting a container and the VS Code server in it takes a while on the first run.
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 300_000 });
  for (const file of fs.readdirSync(__dirname)) {
    if (file.endsWith('.test.js')) {
      mocha.addFile(path.join(__dirname, file));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve(),
    );
  });
}
