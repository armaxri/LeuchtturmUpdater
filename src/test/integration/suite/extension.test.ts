import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';

import * as vscode from 'vscode';

import type { CheckState } from '../../../checker';
import type { LeuchtturmApi } from '../../../extension';
import { IDS } from '../../scenario';

async function api(): Promise<LeuchtturmApi> {
  const ext = vscode.extensions.getExtension<LeuchtturmApi>('armaxri.leuchtturm-updater');
  assert.ok(ext, 'Leuchtturm extension not found');
  return ext.activate();
}

function find(state: CheckState | undefined, id: string) {
  return state?.artifacts.find((a) => a.id === id);
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

  it('refuses to install a VSIX whose SHA-256 does not match', async () => {
    const installed = await vscode.commands.executeCommand<number>(
      'leuchtturm.installVersion',
      IDS.tampered,
      '1.0.0',
    );
    assert.equal(installed, 0);
    assert.ok(!(await installedFolders()).some((f) => f.startsWith(IDS.tampered)));
  });

  it('installs the update when the user asks for it', async () => {
    const installed = await vscode.commands.executeCommand<number>(
      'leuchtturm.installVersion',
      IDS.hello,
      '1.1.0',
    );
    assert.equal(installed, 1);
    assert.ok((await installedFolders()).some((f) => f.startsWith(`${IDS.hello}-1.1.0`)));
    const hello = find((await api()).state, IDS.hello);
    assert.equal(hello?.installedVersion, '1.1.0');
    assert.equal(hello?.status, 'up-to-date');
  });

  it('installs a not-installed artifact', async () => {
    const installed = await vscode.commands.executeCommand<number>(
      'leuchtturm.installVersion',
      IDS.world,
      '0.5.0',
    );
    assert.equal(installed, 1);
    assert.ok((await installedFolders()).some((f) => f.startsWith(`${IDS.world}-0.5.0`)));
  });
});
