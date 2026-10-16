// Bundles src/extension.ts into a single dist/extension.js (CommonJS, as VS Code expects),
// the source editor page into dist/sourceEditor.js, and packages the remote helper (src/helper/) into dist/leuchtturm-remote-helper.vsix, which
// ships inside Leuchtturm's own .vsix.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createVSIX } from '@vscode/vsce';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // `vscode` is provided by the extension host at runtime and must not be bundled.
  external: ['vscode'],
  minify: production,
  logLevel: 'info',
};

/** Builds the helper in a staging folder and packs it; its version follows Leuchtturm's. */
async function buildHelper() {
  const stage = 'out/helper-package';
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await esbuild.build({
    ...common,
    entryPoints: ['src/helper/extension.ts'],
    outfile: `${stage}/extension.js`,
    logLevel: 'warning',
  });
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const manifest = JSON.parse(await readFile('helper/package.json', 'utf8'));
  await writeFile(`${stage}/package.json`, JSON.stringify({ ...manifest, version }, null, 2));
  await cp('helper/README.md', `${stage}/README.md`);
  await cp('LICENSE', `${stage}/LICENSE`);
  await cp('media/icon-128.png', `${stage}/icon.png`);
  // Everything in the staging folder belongs into the package.
  await writeFile(`${stage}/.vscodeignore`, '');
  // dist/ does not exist yet in a fresh checkout (the main bundle is written afterwards).
  await mkdir('dist', { recursive: true });
  await createVSIX({
    cwd: stage,
    packagePath: 'dist/leuchtturm-remote-helper.vsix',
    dependencies: false,
  });
}

const contexts = [
  await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    sourcemap: !production,
  }),
  // The source editor page runs in a webview (a browser frame), not in Node.
  await esbuild.context({
    ...common,
    entryPoints: ['src/sourceEditor/webview/main.ts'],
    outfile: 'dist/sourceEditor.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    external: [],
    sourcemap: production ? false : 'inline',
  }),
];

await buildHelper();
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
