/**
 * Opens the demo scenario in a Dev Containers window. Shared by `npm run test:remote` and
 * `npm run sandbox -- --dev-container`. Needs Docker; the Dev Containers extension is installed
 * into the scenario's own extensions folder (your VS Code is not touched).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { spawnCode } from './codeCli';

export const DEV_CONTAINERS_EXTENSION = 'ms-vscode-remote.remote-containers';
/** Small image with what the VS Code server needs (glibc, tar). */
const IMAGE = 'ubuntu:22.04';
/** Where the scenario workspace appears inside the container. */
export const CONTAINER_FOLDER = '/workspaces/workspace';

/** User settings that keep the Dev Containers extension from touching your git/Docker setup. */
export const DEV_CONTAINER_SETTINGS = {
  'dev.containers.copyGitConfig': false,
  'dev.containers.dockerCredentialHelper': false,
  'dev.containers.gitCredentialHelperConfigLocation': 'none',
} as const;

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Points every `docker` call (ours and the Dev Containers extension's, which inherits our
 * environment) at the engine of the current Docker context. Otherwise the extension uses the
 * `default` context, which can be a different engine (e.g. Podman) than `docker ps` shows.
 */
export function pinDockerEngine(): void {
  let host: string;
  try {
    host = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch (err) {
    throw new Error(
      `Docker is not available (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). ` +
        'Start Docker Desktop (or another engine) and try again.',
      { cause: err },
    );
  }
  if (!process.env.DOCKER_HOST && host) {
    process.env.DOCKER_HOST = host;
  }
}

/**
 * Writes `.devcontainer/devcontainer.json` into the workspace and returns the folder URI that
 * opens it in a container (the same URI "Reopen in Container" uses).
 */
export async function prepareDevContainer(workspace: string): Promise<string> {
  await fs.mkdir(path.join(workspace, '.devcontainer'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, '.devcontainer', 'devcontainer.json'),
    JSON.stringify(
      {
        name: 'Leuchtturm demo',
        image: IMAGE,
        // The workspace may lie inside a git repository (.sandbox/ does); without this the
        // extension would mount the whole repository instead.
        workspaceMount: `source=\${localWorkspaceFolder},target=${CONTAINER_FOLDER},type=bind`,
        workspaceFolder: CONTAINER_FOLDER,
      },
      null,
      2,
    ),
  );
  // `Buffer.toString('hex')`: the authority is the host folder, hex-encoded.
  const hex = Buffer.from(workspace, 'utf8').toString('hex');
  return `vscode-remote://dev-container+${hex}${CONTAINER_FOLDER}`;
}

/** The containers the Dev Containers extension created for this workspace. */
function containers(workspace: string, all = false): string[] {
  return docker([
    'ps',
    ...(all ? ['-a'] : []),
    '-q',
    '--filter',
    `label=devcontainer.local_folder=${workspace}`,
  ])
    .split('\n')
    .filter(Boolean);
}

/** Runs a shell command inside the workspace's running container and returns its stdout. */
export function execInContainer(workspace: string, command: string): string {
  const [id] = containers(workspace);
  if (!id) {
    throw new Error(`No running dev container for ${workspace}`);
  }
  return docker(['exec', id, 'sh', '-c', command]);
}

/** Folder names below the VS Code server's extensions folder in the container. */
export function containerExtensions(workspace: string): string[] {
  return execInContainer(workspace, 'ls ~/.vscode-server/extensions')
    .split('\n')
    .filter((name) => name && name !== 'extensions.json');
}

/** Removes the workspace's containers (running or not). */
export function removeDevContainers(workspace: string): void {
  const ids = containers(workspace, true);
  if (ids.length > 0) {
    docker(['rm', '-f', ...ids]);
  }
}

/**
 * Runs the VS Code CLI without blocking the event loop: downloads from the Marketplace go
 * through the scenario's fake proxy, which runs in this process and must keep answering.
 */
export function runCodeCli(cli: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnCode(cli, args, { stdio: 'inherit' });
    child.on('error', (err) =>
      reject(new Error(`Cannot run "${cli}" (${err.message}). Set CODE_CLI to the VS Code CLI.`)),
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cli} ${args.join(' ')} exited with ${code}`)),
    );
  });
}
