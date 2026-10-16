/**
 * Runs after `npm run package`: checks that the README inside the .vsix can show its images on
 * the extension's page in VS Code's Extensions view.
 *
 * That page only loads images from `https` URLs. Relative paths (even to files inside the
 * .vsix) and `data:` URIs are stripped, which shows a broken-image icon. vsce rewrites the
 * README's relative image links to `https://github.com/armaxri/LeuchtturmUpdater/raw/HEAD/…`,
 * which works because the repository is public; a new image appears once it is pushed.
 *
 * Fails for images that cannot work; reports (without failing) images that do not answer yet,
 * e.g. ones that are not pushed, or when offline.
 *
 * Usage: node out/test/checkPackage.js [file.vsix]   (default: the newest .vsix in the repo)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { listZip, readZipEntry } from '../util/zip';
import { ROOT } from './paths';

/** Image references in Markdown (`![alt](src)`) and HTML (`<img src="…">`). */
export function imageLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    links.push(m[1]!);
  }
  for (const m of markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    links.push(m[1]!);
  }
  return links;
}

/** Why an image link cannot show on the extension page, or undefined if it can. */
export function imageProblem(link: string): string | undefined {
  if (link.startsWith('https://')) {
    return undefined;
  }
  return link.startsWith('http://')
    ? 'plain http: use https'
    : 'not an https URL: VS Code only loads https images on the extension page';
}

async function newestVsix(): Promise<string> {
  const files = (await fs.readdir(ROOT)).filter((f) => f.endsWith('.vsix'));
  const stats = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await fs.stat(path.join(ROOT, f))).mtimeMs })),
  );
  const newest = stats.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) {
    throw new Error('No .vsix found; run `npm run package` first');
  }
  return path.join(ROOT, newest.f);
}

async function answers(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    return res.ok ? undefined : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main(): Promise<void> {
  const vsix = process.argv[2] ?? (await newestVsix());
  const names = (await listZip(vsix)).map((e) => e.name);
  const readmeName = names.find((n) => /^extension\/readme\.md$/i.test(n));
  if (!readmeName) {
    throw new Error(`${vsix} has no README`);
  }
  const readme = (await readZipEntry(vsix, readmeName))!.toString('utf8');
  const links = imageLinks(readme);
  const problems = links.flatMap((link) => {
    const problem = imageProblem(link);
    return problem ? [`${link}: ${problem}`] : [];
  });
  if (problems.length > 0) {
    throw new Error(
      `README images in ${path.basename(vsix)} will not show:\n- ${problems.join('\n- ')}`,
    );
  }
  /* eslint-disable no-console */
  for (const link of links) {
    const failure = await answers(link);
    if (failure) {
      console.warn(`Not reachable yet (${failure}): ${link}. Push it, or check the URL.`);
    }
  }
  console.log(`${path.basename(vsix)}: ${links.length} README image(s) checked.`);
  /* eslint-enable no-console */
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
