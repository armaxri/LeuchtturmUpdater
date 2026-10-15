import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';

import * as vscode from 'vscode';

import type { CheckState } from '../../../checker';
import type { LeuchtturmApi } from '../../../extension';
import type { Node } from '../../../ui/treeModel';
import { IDS } from '../../scenario';

async function api(): Promise<LeuchtturmApi> {
  const ext = vscode.extensions.getExtension<LeuchtturmApi>('armaxri.leuchtturm-updater');
  assert.ok(ext, 'Leuchtturm extension not found');
  return ext.activate();
}

function find(state: CheckState | undefined, id: string) {
  return state?.artifacts.find((a) => a.id === id);
}

function describeTree(nodes: readonly Node[]): unknown[] {
  return nodes.map((n) => {
    switch (n.type) {
      case 'group':
        return { [`${n.group} (${n.count})`]: describeTree(n.children) };
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

  it('ignores sources from workspace settings', () => {
    assert.equal(find(state, IDS.evil), undefined);
    assert.ok(!JSON.stringify(state?.problems).includes('evil'));
  });

  it('reports the offline source as a problem without affecting the others', () => {
    assert.deepEqual(
      state?.problems.map((p) => p.source),
      ['offline'],
    );
    assert.match(state?.problems[0]?.message ?? '', /Folder not found/);
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
      { 'updates (1)': [{ [IDS.hello]: ['1.1.0', '1.0.0'] }] },
      { 'notInstalled (2)': [{ [IDS.tampered]: ['1.0.0'] }, { [IDS.world]: ['0.5.0'] }] },
      { 'problems (1)': [state?.problems[0]?.message] },
    ]);
    assert.equal(a.badge, 1);
    assert.equal(a.statusBar?.visible, true);
    assert.equal(a.statusBar?.text, '$(broadcast) 1');
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
    assert.equal(a.badge, undefined);
    assert.equal(a.statusBar?.visible, false);
    assert.equal(await vscode.commands.executeCommand<number>('leuchtturm.updateAll'), 0);

    await vscode.commands.executeCommand('leuchtturm.clearSkipped');
    assert.equal(find(a.state, IDS.hello)?.status, 'update');
    assert.equal(a.badge, 1);
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

  it('Update All installs every update (and nothing that is not installed)', async () => {
    const installed = await vscode.commands.executeCommand<number>('leuchtturm.updateAll');
    assert.equal(installed, 1);
    assert.ok(!(await installedFolders()).some((f) => f.startsWith(IDS.world)));
    assert.ok((await installedFolders()).some((f) => f.startsWith(`${IDS.hello}-1.1.0`)));
    const hello = find((await api()).state, IDS.hello);
    assert.equal(hello?.installedVersion, '1.1.0');
    assert.equal(hello?.status, 'up-to-date');
    const a = await api();
    assert.equal(a.badge, undefined);
    assert.equal(a.statusBar?.visible, false);
  });

  it('installs a not-installed artifact from its tree node', async () => {
    const node = findNode((await api()).treeModel, IDS.world);
    assert.ok(node);
    const installed = await vscode.commands.executeCommand<number>('leuchtturm.tree.update', node);
    assert.equal(installed, 1);
    assert.ok((await installedFolders()).some((f) => f.startsWith(`${IDS.world}-0.5.0`)));
  });
});
