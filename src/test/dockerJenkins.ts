/**
 * A real Jenkins in Docker, for `npm run full-sandbox` and `npm run test:jenkins`.
 *
 * The image (test/fixtures/jenkins/) is Jenkins LTS with the Pipeline plugins and one pipeline
 * job, `demo-extension`, that packages the next version of "Leuchtturm Demo Jenkins" on every
 * build: build #N archives `dist/leuchtturm-demo.jenkins-1.N.0.vsix`. No login (Leuchtturm
 * handles none); published on 127.0.0.1 only.
 *
 * The image is built once and reused while the fixture files stay the same (the tag is a hash
 * of them). The first build downloads the plugins and takes a few minutes.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { pinDockerEngine } from './devContainer';
import { ROOT } from './paths';

const CONTEXT = path.join(ROOT, 'test/fixtures');
const IMAGE = 'leuchtturm-sandbox-jenkins';
export const JENKINS_CONTAINER = 'leuchtturm-sandbox-jenkins';
export const JENKINS_JOB = 'demo-extension';
export const JENKINS_EXTENSION_ID = 'leuchtturm-demo.jenkins';

export interface DockerJenkins {
  /** e.g. `http://127.0.0.1:49153` */
  url: string;
  /** The pipeline job's page; paste it into "Add Source". */
  jobUrl: string;
  /** Starts a build (like "Build Now") and waits for its result. */
  build(): Promise<{ number: number; result: string }>;
  /** Stops and removes the container. */
  close(): void;
}

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files the image is built from; their hash names the image, so edits rebuild it. */
async function contextHash(): Promise<string> {
  const files = [
    'demo-extension/extension.js',
    ...(await fs.readdir(path.join(CONTEXT, 'jenkins'), { recursive: true })).map((f) =>
      path.join('jenkins', f),
    ),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const full = path.join(CONTEXT, file);
    if ((await fs.stat(full)).isFile()) {
      hash.update(file).update(await fs.readFile(full));
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/** Builds the image unless it exists; streams Docker's output (the first build is slow). */
async function ensureImage(log: (line: string) => void): Promise<string> {
  const tag = `${IMAGE}:${await contextHash()}`;
  try {
    docker(['image', 'inspect', tag]);
    return tag;
  } catch {
    // Not built yet.
  }
  log(`Building the Jenkins image ${tag} (first time: downloads Jenkins plugins, a few minutes)…`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      ['build', '-t', tag, '-f', path.join(CONTEXT, 'jenkins', 'Dockerfile'), CONTEXT],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker build failed (exit code ${code})`)),
    );
  });
  // Older builds of this image (from earlier fixture versions) are no longer needed.
  for (const old of docker(['image', 'ls', IMAGE, '--format', '{{.Repository}}:{{.Tag}}']).split(
    '\n',
  )) {
    if (old && old !== tag) {
      try {
        docker(['image', 'rm', old]);
      } catch {
        // Still used by a container; keep it.
      }
    }
  }
  return tag;
}

/** Jenkins wants a CSRF token ("crumb") with every POST; it belongs to the session cookie. */
async function crumbHeaders(url: string): Promise<Record<string, string>> {
  const res = await fetch(`${url}/crumbIssuer/api/json`);
  const body = (await res.json()) as { crumbRequestField: string; crumb: string };
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { [body.crumbRequestField]: body.crumb, ...(cookie ? { cookie } : {}) };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

async function build(url: string): Promise<{ number: number; result: string }> {
  const res = await fetch(`${url}/job/${JENKINS_JOB}/build`, {
    method: 'POST',
    headers: await crumbHeaders(url),
  });
  const queueItem = res.headers.get('location');
  if (res.status !== 201 || !queueItem) {
    throw new Error(`Triggering a build failed: HTTP ${res.status}`);
  }
  // Queue item → build number → result.
  const end = Date.now() + 5 * 60_000;
  let number: number | undefined;
  while (Date.now() < end) {
    if (number === undefined) {
      const item = await getJson<{ executable?: { number: number } }>(`${queueItem}api/json`);
      number = item.executable?.number;
    } else {
      const b = await getJson<{ building: boolean; result: string | null }>(
        `${url}/job/${JENKINS_JOB}/${number}/api/json?tree=building,result`,
      );
      if (!b.building && b.result) {
        return { number, result: b.result };
      }
    }
    await sleep(1000);
  }
  throw new Error('The Jenkins build did not finish within 5 minutes');
}

/** Builds (if needed) and starts the Jenkins container and waits until the job is there. */
export async function startJenkins(
  log: (line: string) => void = () => undefined,
): Promise<DockerJenkins> {
  pinDockerEngine();
  const image = await ensureImage(log);
  try {
    docker(['rm', '-f', JENKINS_CONTAINER]);
  } catch {
    // No leftover container.
  }
  // Port 0: Docker picks a free port; only reachable from this computer.
  docker(['run', '-d', '--name', JENKINS_CONTAINER, '-p', '127.0.0.1:0:8080', image]);
  const close = () => {
    try {
      docker(['rm', '-f', JENKINS_CONTAINER]);
    } catch {
      // Already gone.
    }
  };
  try {
    const port = docker(['port', JENKINS_CONTAINER, '8080/tcp']).split('\n')[0]!.split(':').at(-1);
    const url = `http://127.0.0.1:${port}`;
    log(`Starting Jenkins on ${url} …`);
    const end = Date.now() + 5 * 60_000;
    for (;;) {
      // 503 "Jenkins is getting ready" until the job exists.
      const ok = await fetch(`${url}/job/${JENKINS_JOB}/api/json`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        break;
      }
      if (Date.now() > end) {
        throw new Error(
          `Jenkins did not start: ${docker(['logs', '--tail', '30', JENKINS_CONTAINER])}`,
        );
      }
      await sleep(1000);
    }
    return { url, jobUrl: `${url}/job/${JENKINS_JOB}/`, build: () => build(url), close };
  } catch (err) {
    close();
    throw err;
  }
}
