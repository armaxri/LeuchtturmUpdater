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
 *
 * Plus two local servers (see fakeServer.ts), running while the scenario is open:
 *   fake Jenkins (http, basic auth with ${secret:jenkins-demo}, jsonPath matcher)
 *     job demo-ci: #42 leuchtturm-demo.ci 2.1.0 (+ CHANGELOG.md), #41 2.0.0 ← pre-installed,
 *     #40 failed
 *   web server listing over HTTPS with the test CA (regex matcher)
 *     /vsix/leuchtturm-demo.web-0.3.0.vsix        → not installed
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { startFakeServer, type FakeServer } from './fakeServer';
import { packageFixture, ROOT } from './packageFixture';
import { TLS_CERT } from './paths';

const DEMO = path.join(ROOT, 'test/fixtures/demo-extension');

export const IDS = {
  hello: 'leuchtturm-demo.hello',
  world: 'leuchtturm-demo.world',
  tampered: 'leuchtturm-demo.tampered',
  evil: 'leuchtturm-demo.evil',
  ci: 'leuchtturm-demo.ci',
  web: 'leuchtturm-demo.web',
} as const;

/** The fake Jenkins expects this; the user stores it with "Store Credential…". */
export const JENKINS_SECRET = { name: 'jenkins-demo', value: 'demo-password' } as const;

export interface Scenario {
  root: string;
  share: string;
  workspace: string;
  userDataDir: string;
  extensionsDir: string;
  /** VSIX files to install before starting VS Code. */
  preinstall: string[];
  jenkinsUrl: string;
  webUrl: string;
  /** Stops the fake servers. */
  close(): Promise<void>;
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

  const ci = (v: string) => path.join(root, 'ci-builds', `${IDS.ci}-${v}.vsix`);
  await demo('ci', 'Leuchtturm Demo CI', '2.0.0', ci('2.0.0'));
  await demo('ci', 'Leuchtturm Demo CI', '2.1.0', ci('2.1.0'));
  const webDir = path.join(root, 'web');
  await demo('web', 'Leuchtturm Demo Web', '0.3.0', path.join(webDir, `${IDS.web}-0.3.0.vsix`));

  const servers: FakeServer[] = [
    await startFakeServer({
      auth: { user: 'demo', password: JENKINS_SECRET.value },
      jenkins: {
        job: 'demo-ci',
        builds: [
          {
            number: 42,
            result: 'SUCCESS',
            artifacts: { [`dist/${IDS.ci}-2.1.0.vsix`]: ci('2.1.0') },
            changelog:
              '## 2.1.0\n- Built by the fake Jenkins\n- Fetched with your stored credential\n',
          },
          {
            number: 41,
            result: 'SUCCESS',
            artifacts: { [`dist/${IDS.ci}-2.0.0.vsix`]: ci('2.0.0') },
          },
          { number: 40, result: 'FAILURE', artifacts: {} },
        ],
      },
    }),
    await startFakeServer({ tls: true, autoindex: { dir: webDir } }),
  ];
  const [jenkins, web] = servers as [FakeServer, FakeServer];

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
      jenkins: {
        type: 'http',
        index: {
          url: `${jenkins.url}/job/demo-ci/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,20}`,
        },
        auth: { basic: { user: 'demo', password: `\${secret:${JENKINS_SECRET.name}}` } },
        match: {
          jsonPath: '$.builds[*].artifacts[*]',
          where: { result: 'SUCCESS' },
          field: 'fileName',
          regex: '^(?<id>leuchtturm-demo\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix$',
        },
        download: { url: `${jenkins.url}/job/demo-ci/\${number}/artifact/\${relativePath}` },
        releaseNotes: { url: `${jenkins.url}/job/demo-ci/\${number}/artifact/CHANGELOG.md` },
      },
      web: {
        type: 'http',
        index: { url: `${web.url}/vsix/` },
        match: {
          regex:
            'href="(?<file>(?<id>leuchtturm-demo\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix)"',
        },
        download: { url: `${web.url}/vsix/\${file}` },
        ca: TLS_CERT,
      },
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

  return {
    root,
    share,
    workspace,
    userDataDir,
    extensionsDir,
    preinstall: [hello('1.0.0'), ci('2.0.0')],
    jenkinsUrl: jenkins.url,
    webUrl: web.url,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}
