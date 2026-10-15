/**
 * Builds the demo scenario used by both `npm run sandbox` (manual exploration) and the
 * integration tests, so what you click through in the sandbox is also tested automatically.
 *
 *   share/
 *     leuchtturm-demo.hello-1.0.0.vsix           ← pre-installed
 *     leuchtturm-demo.hello-1.1.0.vsix (+ .sha256, .md)   → shows as an update
 *     leuchtturm-demo.hello-1.2.0-beta.1.vsix    → hidden unless includePrerelease
 *     leuchtturm-demo/leuchtturm-demo.world-0.5.0.vsix    → not installed (publisher layout)
 *     leuchtturm-demo.tampered-1.0.0.vsix (+ wrong .sha256) → install must fail
 *   evil-share/leuchtturm-demo.evil-6.6.6.vsix   → only referenced from *workspace* settings;
 *                                                  must never show up
 *   workspace/.vscode/settings.json               → tries to inject the evil source
 *   user-data/User/settings.json                  → the real (user-level) configuration
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { packageFixture, ROOT } from './packageFixture';

const DEMO = path.join(ROOT, 'test/fixtures/demo-extension');

export const IDS = {
  hello: 'leuchtturm-demo.hello',
  world: 'leuchtturm-demo.world',
  tampered: 'leuchtturm-demo.tampered',
  evil: 'leuchtturm-demo.evil',
} as const;

export interface Scenario {
  root: string;
  share: string;
  workspace: string;
  userDataDir: string;
  extensionsDir: string;
  /** VSIX files to install before starting VS Code. */
  preinstall: string[];
}

/** Packages the demo extension under another name (with matching command IDs). */
async function demo(name: string, displayName: string, version: string, out: string) {
  await packageFixture(
    DEMO,
    {
      name,
      displayName,
      version,
      contributes: {
        commands: [
          {
            command: `leuchtturm-demo.${name}.version`,
            title: 'Which version is active?',
            category: displayName,
          },
        ],
      },
    },
    out,
  );
  return out;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

/**
 * Creates the scenario below `root` (which is wiped first). `settings` overrides the
 * generated user settings, e.g. to silence notifications in tests.
 */
export async function buildScenario(
  root: string,
  settings: Record<string, unknown> = {},
): Promise<Scenario> {
  await fs.rm(root, { recursive: true, force: true });
  const share = path.join(root, 'share');
  const evilShare = path.join(root, 'evil-share');
  const workspace = path.join(root, 'workspace');
  const userDataDir = path.join(root, 'user-data');
  const extensionsDir = path.join(root, 'extensions');
  await fs.mkdir(extensionsDir, { recursive: true });

  const hello = (v: string) => path.join(share, `${IDS.hello}-${v}.vsix`);
  await demo('hello', 'Leuchtturm Demo Hello', '1.0.0', hello('1.0.0'));
  await demo('hello', 'Leuchtturm Demo Hello', '1.1.0', hello('1.1.0'));
  await fs.writeFile(
    `${hello('1.1.0')}.sha256`,
    `${await sha256(hello('1.1.0'))}  ${path.basename(hello('1.1.0'))}\n`,
  );
  await fs.writeFile(
    path.join(share, `${IDS.hello}-1.1.0.md`),
    '## 1.1.0\n- Shows the version in the status bar\n',
  );
  await demo('hello', 'Leuchtturm Demo Hello', '1.2.0-beta.1', hello('1.2.0-beta.1'));

  await demo(
    'world',
    'Leuchtturm Demo World',
    '0.5.0',
    path.join(share, 'leuchtturm-demo', `${IDS.world}-0.5.0.vsix`),
  );

  const tampered = path.join(share, `${IDS.tampered}-1.0.0.vsix`);
  await demo('tampered', 'Leuchtturm Demo Tampered', '1.0.0', tampered);
  await fs.writeFile(`${tampered}.sha256`, `${'0'.repeat(64)}  ${path.basename(tampered)}\n`);

  await demo(
    'evil',
    'Leuchtturm Demo Evil',
    '6.6.6',
    path.join(evilShare, `${IDS.evil}-6.6.6.vsix`),
  );

  // Workspace settings try to add a source. Leuchtturm must ignore it (SPEC §9).
  await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await fs.writeFile(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify(
      {
        'leuchtturm.sources': { evil: { type: 'file', path: evilShare } },
        'leuchtturm.script.enabled': true,
      },
      null,
      2,
    ),
  );
  await fs.copyFile(
    path.join(ROOT, 'test/fixtures/sandbox-workspace/TRY-ME.md'),
    path.join(workspace, 'TRY-ME.md'),
  );

  const userSettings = {
    'leuchtturm.sources': {
      share: { type: 'file', path: share },
      offline: { type: 'file', path: path.join(root, 'does-not-exist'), timeout: 5 },
    },
    'leuchtturm.trackAllFromSources': true,
    'leuchtturm.checkOnStartup': true,
    'leuchtturm.checkInterval': 5,
    // Keep the sandbox quiet and deterministic.
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    ...settings,
  };
  await fs.mkdir(path.join(userDataDir, 'User'), { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify(userSettings, null, 2),
  );

  return { root, share, workspace, userDataDir, extensionsDir, preinstall: [hello('1.0.0')] };
}
