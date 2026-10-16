// Bundles src/extension.ts into a single dist/extension.js (CommonJS, as VS Code expects),
// and packages the remote helper (src/helper/) into dist/leuchtturm-remote-helper.vsix, which
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

const ctx = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  sourcemap: !production,
});

await buildHelper();
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
