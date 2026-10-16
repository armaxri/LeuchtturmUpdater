import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';

import * as vscode from 'vscode';

import type { CheckState } from '../../../checker';
import type { LeuchtturmApi } from '../../../extension';
import type { Node } from '../../../ui/treeModel';
import { IDS, JENKINS_SECRET, NPM_TOKEN } from '../../scenario';

async function api(): Promise<LeuchtturmApi> {
  const ext = vscode.extensions.getExtension<LeuchtturmApi>('armaxri.leuchtturm-updater');
  assert.ok(ext, 'Leuchtturm extension not found');
  return ext.activate();
}

function find(state: CheckState | undefined, id: string) {
  return state?.artifacts.find((a) => a.id === id);
}

function problem(state: CheckState | undefined, source: string) {
  return state?.problems.find((p) => p.source === source);
}

async function setScriptsEnabled(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('leuchtturm')
    .update('script.enabled', enabled, vscode.ConfigurationTarget.Global);
}

function describeTree(nodes: readonly Node[]): unknown[] {
  return nodes.map((n) => {
    switch (n.type) {
      case 'group':
        // Sorted by ID so the expectation does not depend on display-name collation.
        return {
          [`${n.group} (${n.count})`]: describeTree(
            [...n.children].sort((a, b) =>
              a.type === 'artifact' && b.type === 'artifact'
                ? a.artifact.id.localeCompare(b.artifact.id)
                : 0,
            ),
          ),
        };
      case 'artifact':
        return { [n.artifact.id]: describeTree(n.children) };
      case 'version':
        return n.candidate.version;
      case 'problem':
        return n.problem.message;
      case 'kind':
        return { [n.kind]: describeTree(n.children) };
    }
  });
}

function findNode(nodes: readonly Node[], id: string): Node | undefined {
  for (const n of nodes) {
    if (n.type === 'artifact' && n.artifact.id === id) {
      return n;
    }
    if (n.type === 'group' || n.type === 'kind') {
      const found = findNode(n.children, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

async function installedFolders(): Promise<string[]> {
  const dir = process.env.LEUCHTTURM_IT_EXTENSIONS_DIR;
  assert.ok(dir, 'LEUCHTTURM_IT_EXTENSIONS_DIR not set');
  return fs.readdir(dir);
}

describe('Leuchtturm end to end (demo scenario, file source)', () => {
  let state: CheckState | undefined;

  before(async () => {
    state = await (await api()).checkNow();
    assert.ok(state, 'check returned no state');
  });

  it('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'leuchtturm.checkNow',
      'leuchtturm.update',
      'leuchtturm.installVersion',
      'leuchtturm.clearSkipped',
      'leuchtturm.showLog',
      'leuchtturm.updateAll',
      'leuchtturm.testSource',
      'leuchtturm.openSettings',
      'leuchtturm.setSecret',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  it('offers the update for the pre-installed demo and hides the prerelease', () => {
    const hello = find(state, IDS.hello);
    assert.equal(hello?.installedVersion, '1.0.0');
    assert.equal(hello?.status, 'update');
    assert.equal(hello?.latest?.version, '1.1.0');
    assert.match(hello?.latest?.available.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.match(hello?.latest?.available.releaseNotes ?? '', /1\.1\.0/);
    assert.deepEqual(
      hello?.candidates.map((c) => c.version),
      ['1.1.0', '1.0.0'],
    );
  });

  it('lists not-installed artifacts, including the publisher folder layout', () => {
    assert.equal(find(state, IDS.world)?.status, 'not-installed');
    assert.equal(find(state, IDS.tampered)?.status, 'not-installed');
  });

  it('reads a web server listing over HTTPS with a custom CA (http source)', () => {
    const web = find(state, IDS.web);
    assert.equal(web?.status, 'not-installed');
    assert.equal(web?.latest?.sourceName, 'web');
    assert.equal(web?.latest?.sourceType, 'http');
  });

  it('reads an npm registry: scope search, .npmrc token, IDs from package.json or the .vsix', () => {
    const registry = find(state, IDS.registry);
    assert.equal(registry?.installedVersion, '3.0.0');
    assert.equal(registry?.status, 'update');
    assert.equal(registry?.latest?.version, '3.1.0');
    assert.equal(registry?.latest?.sourceType, 'npm');
    assert.equal(find(state, IDS.packed)?.status, 'not-installed');
  });

  it('ignores sources from workspace settings', () => {
    assert.equal(find(state, IDS.evil), undefined);
    assert.ok(!JSON.stringify(state?.problems).includes('evil'));
  });

  it('reports a missing credential and an offline source without affecting the others', () => {
    assert.deepEqual(
      state?.problems.map((p) => p.source),
      ['jenkins', 'script', 'offline'],
    );
    assert.match(problem(state, 'jenkins')?.message ?? '', /Secret "jenkins-demo" is not stored/);
    assert.match(problem(state, 'offline')?.message ?? '', /Folder not found/);
    // The pre-installed CI demo is only offered by Jenkins, so it is not listed yet.
    assert.equal(find(state, IDS.ci), undefined);
  });

  it('a check never installs anything', async () => {
    const folders = await installedFolders();
    assert.ok(folders.some((f) => f.startsWith(`${IDS.hello}-1.0.0`)));
    assert.ok(!folders.some((f) => f.startsWith(`${IDS.hello}-1.1.0`)));
    assert.ok(!folders.some((f) => f.startsWith(IDS.world)));
  });

  it('shows the state in the tree, the badge and the status bar', async () => {
    const a = await api();
    assert.deepEqual(describeTree(a.treeModel), [
      {
        'updates (2)': [
          { [IDS.hello]: ['1.1.0', '1.0.0'] },
          { [IDS.registry]: ['3.1.0', '3.0.0'] },
        ],
      },
      {
        'notInstalled (6)': [
          { [IDS.mislabeled]: ['1.0.0'] },
          { [IDS.packed]: ['0.9.0'] },
          { [IDS.tampered]: ['1.0.0'] },
          { [IDS.web]: ['0.3.0'] },
          { [IDS.world]: ['0.5.0'] },
          { [IDS.impostor]: ['1.0.0'] },
        ],
      },
      { 'problems (3)': state?.problems.map((p) => p.message) },
    ]);
    assert.equal(a.badge, 2);
    assert.equal(a.statusBar?.visible, true);
    assert.equal(a.statusBar?.text, '$(broadcast) 2');
  });

  it('Test Source explains what a source found', async () => {
    const report = await vscode.commands.executeCommand<string>('leuchtturm.testSource', 'share');
    assert.match(
      report,
      /matched {2}leuchtturm-demo\.hello-1\.1\.0\.vsix → leuchtturm-demo\.hello 1\.1\.0/,
    );
    assert.match(report, /leuchtturm-demo\.hello-1\.1\.0\.vsix\n/);
    assert.match(report, /1\.1\.0 {2}\(sha256 [0-9a-f]{12}…, release notes\)/);
    const offline = await vscode.commands.executeCommand<string>(
      'leuchtturm.testSource',
      'offline',
    );
    assert.match(offline, /FAILED .*Folder not found/);
    const unknown = await vscode.commands.executeCommand<string>('leuchtturm.testSource', 'evil');
    assert.match(unknown, /No enabled source named "evil"/);
  });

  it('skipping a version from the tree hides it from the badge until reset', async () => {
    const a = await api();
    const node = findNode(a.treeModel, IDS.hello);
    assert.ok(node);
    await vscode.commands.executeCommand('leuchtturm.tree.skip', node);
    assert.equal(find(a.state, IDS.hello)?.status, 'skipped');
    assert.equal(a.badge, 1);
    assert.equal(a.statusBar?.text, '$(broadcast) 1');

    await vscode.commands.executeCommand('leuchtturm.clearSkipped');
    assert.equal(find(a.state, IDS.hello)?.status, 'update');
    assert.equal(a.badge, 2);
  });

  it('Store Credential makes the Jenkins source work (basic auth, jsonPath)', async () => {
    const a = await api();
    const ok = await vscode.commands.executeCommand<boolean>(
      'leuchtturm.setSecret',
      JENKINS_SECRET.name,
      JENKINS_SECRET.value,
    );
    assert.equal(ok, true);
    const ci = find(a.state, IDS.ci);
    assert.equal(ci?.installedVersion, '2.0.0');
    assert.equal(ci?.status, 'update');
    assert.equal(ci?.latest?.version, '2.1.0');
    assert.equal(ci?.latest?.available.ref.number, '42');
    assert.deepEqual(
      a.state?.problems.map((p) => p.source),
      ['script', 'offline'],
    );
    assert.equal(a.badge, 3);

    const report = await vscode.commands.executeCommand<string>('leuchtturm.testSource', 'jenkins');
    assert.match(report, /→ HTTP 200 OK/);
    assert.match(report, /matched {2}leuchtturm-demo\.ci 2\.1\.0/);
    assert.match(
      report,
      /download http:\/\/jenkins\.leuchtturm\.test:\d+\/job\/demo-ci\/42\/artifact\/dist\//,
    );
    assert.ok(!report.includes(JENKINS_SECRET.value), 'the password must not appear in the log');
  });

  it('Test Source explains the npm registry lookup without leaking the token', async () => {
    const report = await vscode.commands.executeCommand<string>('leuchtturm.testSource', 'npm');
    assert.match(report, /Search for @leuchtturm-demo: 2 package\(s\)/);
    assert.match(report, /extension ID leuchtturm-demo\.packed taken from the \.vsix in 0\.9\.0/);
    assert.match(
      report,
      /matched {2}@leuchtturm-demo\/registry@3\.1\.0 → leuchtturm-demo\.registry 3\.1\.0/,
    );
    assert.ok(!report.includes(NPM_TOKEN), 'the npm token must not appear in the log');
  });

  it('fetches release notes through the source, with its credentials', async () => {
    const node = findNode((await api()).treeModel, IDS.ci);
    assert.ok(node);
    await vscode.commands.executeCommand('leuchtturm.tree.releaseNotes', node);
    const doc = vscode.workspace.textDocuments.find((d) =>
      d.getText().includes('Built by the fake Jenkins'),
    );
    assert.ok(doc, 'release notes document not opened');
    assert.match(doc.getText(), /^# Leuchtturm Demo CI 2\.1\.0/);
  });

  it('keeps script sources off until the user setting enables them (workspace value ignored)', async () => {
    const p = problem(state, 'script');
    assert.match(p?.message ?? '', /Script sources are disabled/);
    assert.equal(p?.action?.command, 'workbench.action.openGlobalSettings');
    assert.equal(find(state, IDS.scripted), undefined);
    // The fix must be a real command that accepts these arguments (opens the user settings).
    await vscode.commands.executeCommand(p.action.command, ...(p.action.arguments ?? []));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('runs a Python script source after the user enables and approves it', async () => {
    const a = await api();
    await setScriptsEnabled(true);
    let s = await a.checkNow();
    // Enabled, but this command + script has not been approved yet.
    const waiting = problem(s, 'script');
    assert.match(waiting?.message ?? '', /Waiting for your approval to run ".*folder_source\.py"/);
    assert.equal(waiting?.action?.command, 'leuchtturm.approveScript');
    assert.equal(find(s, IDS.scripted), undefined);

    assert.equal(
      await vscode.commands.executeCommand('leuchtturm.approveScript', 'script', true),
      true,
    );
    s = a.state;
    assert.equal(problem(s, 'script'), undefined);
    const scripted = find(s, IDS.scripted);
    assert.equal(scripted?.status, 'not-installed');
    assert.equal(scripted?.latest?.sourceType, 'script');
    assert.deepEqual(
      scripted?.candidates.map((c) => c.version),
      ['1.1.0', '1.0.0'],
    );
    assert.match(scripted?.latest?.available.releaseNotes ?? '', /folder_source\.py/);
    assert.match(scripted?.latest?.available.sha256 ?? '', /^[0-9a-f]{64}$/);

    const report = await vscode.commands.executeCommand<string>('leuchtturm.testSource', 'script');
    assert.match(report, /\$ ".*" ".*folder_source\.py" "get_versions"/);
    assert.match(report, /stderr: found 2 file\(s\)/);
    assert.match(report, /exit code 0/);

    const node = findNode(a.treeModel, IDS.scripted);
    assert.ok(node);
    assert.equal(await vscode.commands.executeCommand<number>('leuchtturm.tree.update', node), 1);
    assert.ok((await installedFolders()).some((f) => f.startsWith(`${IDS.scripted}-1.1.0`)));
  });

  it('stops running scripts as soon as the setting is turned off again', async () => {
    await setScriptsEnabled(false);
    const s = await (await api()).checkNow();
    assert.match(problem(s, 'script')?.message ?? '', /Script sources are disabled/);
  });

  it('refuses to install a VSIX whose SHA-256 does not match', async () => {
    const installed = await vscode.commands.executeCommand<number>(
      'leuchtturm.installVersion',
      IDS.tampered,
      '1.0.0',
    );
    assert.equal(installed, 0);
    assert.ok(!(await installedFolders()).some((f) => f.startsWith(IDS.tampered)));
  });

  it('refuses a VSIX whose manifest names another extension', async () => {
    const installed = await vscode.commands.executeCommand<number>(
      'leuchtturm.installVersion',
      IDS.mislabeled,
      '1.0.0',
    );
    assert.equal(installed, 0);
    assert.ok(!(await installedFolders()).some((f) => f.includes('mislabeled')));
  });

  it('Update All installs every update (and nothing that is not installed)', async () => {
    const installed = await vscode.commands.executeCommand<number>('leuchtturm.updateAll');
    assert.equal(installed, 3);
    const folders = await installedFolders();
    assert.ok(folders.some((f) => f.startsWith(`${IDS.ci}-2.1.0`)));
    assert.ok(folders.some((f) => f.startsWith(`${IDS.registry}-3.1.0`)));
    assert.ok(!(await installedFolders()).some((f) => f.startsWith(IDS.world)));
    assert.ok((await installedFolders()).some((f) => f.startsWith(`${IDS.hello}-1.1.0`)));
    const hello = find((await api()).state, IDS.hello);
    assert.equal(hello?.installedVersion, '1.1.0');
    assert.equal(hello?.status, 'up-to-date');
    const a = await api();
    assert.equal(a.badge, undefined);
    assert.equal(a.statusBar?.visible, false);
  });

  it('sends every request through the configured proxy (http.proxy)', async () => {
    const proxy = process.env.LEUCHTTURM_IT_PROXY;
    assert.ok(proxy);
    // Ask the proxy directly what it has seen (Node's http, not VS Code's patched one).
    const seen = await new Promise<string[]>((resolve, reject) => {
      http
        .get(`${proxy}/__seen`, { agent: new http.Agent() }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve(JSON.parse(body) as string[]));
        })
        .on('error', reject);
    });
    assert.ok(
      seen.some((l) => l.startsWith('CONNECT web.leuchtturm.test:')),
      'no HTTPS tunnel (web source)',
    );
    assert.ok(
      seen.some((l) => l.includes('/job/demo-ci/')),
      'Jenkins requests not proxied',
    );
    assert.ok(
      seen.some((l) => l.includes('/npm/')),
      'npm requests not proxied',
    );
  });

  it('installs not-installed artifacts from their tree nodes (file, https, npm)', async () => {
    for (const [id, version] of [
      [IDS.world, '0.5.0'],
      [IDS.web, '0.3.0'],
      [IDS.packed, '0.9.0'],
    ] as const) {
      const node = findNode((await api()).treeModel, id);
      assert.ok(node, `${id} not in the tree`);
      const installed = await vscode.commands.executeCommand<number>(
        'leuchtturm.tree.update',
        node,
      );
      assert.equal(installed, 1);
      assert.ok((await installedFolders()).some((f) => f.startsWith(`${id}-${version}`)));
    }
  });
});
