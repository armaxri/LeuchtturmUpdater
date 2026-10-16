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
 *     leuchtturm-demo.mislabeled-1.0.0.vsix (contains hello) → install must fail (manifest check)
 *     leuchtturm-impostor.hello-1.0.0.vsix (contains leuchtturm-demo.hello) → needs confirmation
 *   evil-share/leuchtturm-demo.evil-6.6.6.vsix   → only referenced from *workspace* settings;
 *                                                  must never show up
 *   workspace/.vscode/settings.json               → tries to inject the evil source
 *   user-data/User/settings.json                  → the real (user-level) configuration
 *
 * Plus local servers (see fakeServer.ts), running while the scenario is open:
 *   fake Jenkins (http, no login, jsonPath matcher)
 *     job demo-ci: #42 leuchtturm-demo.ci 2.1.0 (+ CHANGELOG.md), #41 2.0.0 ← pre-installed,
 *     #40 failed
 *   a second fake Jenkins that needs a login (job secret-ci): not a source; pasting its link
 *     into "Add Source" must point to script sources, as Leuchtturm handles no logins
 *   web server listing over HTTPS; its certificate is trusted like a company CA installed on
 *     the machine (NODE_EXTRA_CA_CERTS, see `env`), with no setting in Leuchtturm
 *     /vsix/leuchtturm-demo.web-0.3.0.vsix        → not installed
 *   npm registry that needs a token: configured for npm itself in the scenario's own .npmrc
 *   (registry, token, proxy), like a user's `npm login`; Leuchtturm just runs npm
 *     @leuchtturm-demo/registry 3.0.0 ← pre-installed, 3.1.0 ("vscodeExtension" field)
 *     @leuchtturm-demo/packed 0.9.0               → ID derived from the .vsix inside
 *
 * And a `script` source running examples/script/folder_source.py on script-share/
 * (leuchtturm-demo.scripted 1.0.0, 1.1.0). `leuchtturm.script.enabled` starts out false in the
 * user settings (the workspace sets it to true, which must be ignored).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { proxyOnlyUrl, startFakeProxy, startFakeServer, type FakeServer } from './fakeServer';
import { packageFixture, ROOT } from './packageFixture';
import { TLS_CERT } from './paths';
import { findPython } from './python';
import { makeTgz } from './tarball';

const DEMO = path.join(ROOT, 'test/fixtures/demo-extension');

export const IDS = {
  hello: 'leuchtturm-demo.hello',
  world: 'leuchtturm-demo.world',
  tampered: 'leuchtturm-demo.tampered',
  evil: 'leuchtturm-demo.evil',
  ci: 'leuchtturm-demo.ci',
  web: 'leuchtturm-demo.web',
  registry: 'leuchtturm-demo.registry',
  packed: 'leuchtturm-demo.packed',
  scripted: 'leuchtturm-demo.scripted',
  mislabeled: 'leuchtturm-demo.mislabeled',
  impostor: 'leuchtturm-impostor.hello',
} as const;

/** Token the fake npm registry expects; the scenario writes it into its own `.npmrc`. */
export const NPM_TOKEN = 'npm-demo-token';

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
  npmUrl: string;
  /** Company-style proxy that all requests go through (`http.proxy`). */
  proxyUrl: string;
  /** Job page of the Jenkins that needs a login (for the "needs a login" case). */
  protectedJenkinsUrl: string;
  /**
   * Environment for the VS Code process: trust for the HTTPS demo server (like a company CA
   * installed on the machine) and the npm configuration (like the user's own ~/.npmrc).
   */
  env: Record<string, string>;
  /** Python used by the `script` source; undefined if none was found (source omitted). */
  python?: string;
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

function omit<T extends object>(names: readonly string[], record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !names.includes(k))) as T;
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
  /** Source names to leave out of the user settings (e.g. for tidy screenshots). */
  omitSources: readonly string[] = [],
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

  // File names that lie about their content: the manifest check must catch them.
  await fs.copyFile(hello('1.0.0'), path.join(share, `${IDS.mislabeled}-1.0.0.vsix`));
  await fs.copyFile(hello('1.0.0'), path.join(share, `${IDS.impostor}-1.0.0.vsix`));

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

  const scriptShare = path.join(root, 'script-share');
  const scripted = (v: string) => path.join(scriptShare, `${IDS.scripted}-${v}.vsix`);
  await demo('scripted', 'Leuchtturm Demo Scripted', '1.0.0', scripted('1.0.0'));
  await demo('scripted', 'Leuchtturm Demo Scripted', '1.1.0', scripted('1.1.0'));
  await fs.writeFile(
    path.join(scriptShare, `${IDS.scripted}-1.1.0.md`),
    '## 1.1.0\n- Listed by examples/script/folder_source.py\n',
  );
  const python = findPython();

  // npm packages wrap a .vsix, like `npm pack` would produce from examples/npm.
  const npmVsix = (name: string, display: string, v: string) =>
    demo(name, display, v, path.join(root, 'npm-build', `${name}-${v}.vsix`));
  const wrap = async (vsix: string) =>
    makeTgz({
      'package/package.json': '{}',
      [`package/${path.basename(vsix)}`]: await fs.readFile(vsix),
    });
  const registry = (v: string) => npmVsix('registry', 'Leuchtturm Demo Registry', v);
  const registry300 = await registry('3.0.0');
  const npmPackages = {
    '@leuchtturm-demo/registry': {
      '3.0.0': { tgz: await wrap(registry300), manifest: { vscodeExtension: IDS.registry } },
      '3.1.0': {
        tgz: await wrap(await registry('3.1.0')),
        manifest: { vscodeExtension: IDS.registry },
      },
    },
    '@leuchtturm-demo/packed': {
      '0.9.0': {
        // No "vscodeExtension": Leuchtturm reads the ID from the .vsix file name.
        manifest: { displayName: 'Leuchtturm Demo Packed' },
        tgz: await wrap(
          await demo(
            'packed',
            'Leuchtturm Demo Packed',
            '0.9.0',
            path.join(root, 'npm-build', `${IDS.packed}-0.9.0.vsix`),
          ),
        ),
      },
    },
  };

  const servers: FakeServer[] = [
    await startFakeServer({
      jenkins: {
        job: 'demo-ci',
        builds: [
          {
            number: 42,
            result: 'SUCCESS',
            artifacts: { [`dist/${IDS.ci}-2.1.0.vsix`]: ci('2.1.0') },
            changelog: '## 2.1.0\n- Built by the fake Jenkins\n- Found through its JSON API\n',
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
    await startFakeServer({ npm: { token: NPM_TOKEN, packages: npmPackages } }),
    await startFakeServer({
      auth: { user: 'demo', password: 'demo-password' },
      jenkins: {
        job: 'secret-ci',
        builds: [
          { number: 1, result: 'SUCCESS', artifacts: { [`${IDS.ci}-2.1.0.vsix`]: ci('2.1.0') } },
        ],
      },
    }),
  ];
  const proxy = await startFakeProxy();
  servers.push(proxy as unknown as FakeServer);
  // The servers listen on 127.0.0.1, but the sources use names only the proxy can resolve,
  // so every request must really go through the proxy.
  const [jenkins, web, npm, protectedJenkins] = (
    servers as [FakeServer, FakeServer, FakeServer, FakeServer]
  ).map((s, i) => ({
    ...s,
    url: proxyOnlyUrl(['jenkins', 'web', 'npm', 'login'][i]!, s.url),
  })) as [FakeServer, FakeServer, FakeServer, FakeServer];
  // npm is configured the npm way, in a scenario-local .npmrc (your own ~/.npmrc is not
  // touched): which registry serves the scope, its token, and the company proxy.
  const npmrc = path.join(root, 'npmrc');
  await fs.writeFile(
    npmrc,
    [
      `@leuchtturm-demo:registry=${npm.url}/npm/`,
      `${npm.url.replace(/^https?:/, '')}/npm/:_authToken=${NPM_TOKEN}`,
      `proxy=${proxy.url}`,
      `https-proxy=${proxy.url}`,
      '',
    ].join('\n'),
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
    'leuchtturm.sources': omit(omitSources, {
      share: { type: 'file', path: share },
      offline: { type: 'file', path: path.join(root, 'does-not-exist'), timeout: 5 },
      jenkins: {
        type: 'http',
        index: {
          url: `${jenkins.url}/job/demo-ci/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,20}`,
        },
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
      },
      // No registry, token or proxy here: npm knows them from its own configuration.
      npm: { type: 'npm', scope: '@leuchtturm-demo' },
      ...(python
        ? {
            script: {
              type: 'script',
              command: python,
              script: path.join(ROOT, 'examples/script/folder_source.py'),
              env: { VSIX_FOLDER: scriptShare },
              timeout: 30,
            },
          }
        : {}),
    }),
    // Off until the user turns it on in their user settings (the workspace value is ignored).
    'leuchtturm.script.enabled': false,
    // Like a company network: everything goes through a proxy.
    'http.proxy': proxy.url,
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
    preinstall: [hello('1.0.0'), ci('2.0.0'), registry300],
    jenkinsUrl: jenkins.url,
    webUrl: web.url,
    npmUrl: `${npm.url}/npm/`,
    proxyUrl: proxy.url,
    protectedJenkinsUrl: `${protectedJenkins.url}/job/secret-ci/`,
    env: {
      NODE_EXTRA_CA_CERTS: TLS_CERT,
      // Both spellings: `npm run …` puts its own lowercase npm_config_userconfig into the
      // environment of everything it starts, and npm prefers that one.
      NPM_CONFIG_USERCONFIG: npmrc,
      npm_config_userconfig: npmrc,
    },
    python,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}
