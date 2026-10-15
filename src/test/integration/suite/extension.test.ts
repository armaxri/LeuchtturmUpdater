import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';

import * as vscode from 'vscode';

import type { LeuchtturmApi } from '../../../extension';

const SAMPLE = 'leuchtturm-test.sample';

async function api(): Promise<LeuchtturmApi> {
  const ext = vscode.extensions.getExtension<LeuchtturmApi>('armaxri.leuchtturm-updater');
  assert.ok(ext, 'Leuchtturm extension not found');
  return ext.activate();
}

describe('Leuchtturm end to end (file source)', () => {
  it('registers its commands', async () => {
    await api();
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

  it('finds the fixture on the share and does not install it during a check', async () => {
    const state = await (await api()).checkNow();
    assert.ok(state, 'check returned no state');
    assert.deepEqual(state.problems, []);
    const sample = state.artifacts.find((a) => a.id === SAMPLE);
    assert.ok(sample, 'sample artifact missing');
    assert.equal(sample.status, 'not-installed');
    assert.equal(sample.latest?.version, '1.1.0');
    assert.deepEqual(
      sample.candidates.map((c) => c.version),
      ['1.1.0', '1.0.0'],
    );
    assert.equal(vscode.extensions.getExtension(SAMPLE), undefined);
  });

  it('installs a version when the user asks for it', async () => {
    const installed = await vscode.commands.executeCommand<number>(
      'leuchtturm.installVersion',
      SAMPLE,
      '1.1.0',
    );
    assert.equal(installed, 1);

    const extensionsDir = process.env.LEUCHTTURM_IT_EXTENSIONS_DIR;
    assert.ok(extensionsDir);
    const entries = await fs.readdir(extensionsDir);
    assert.ok(
      entries.includes(`${SAMPLE}-1.1.0`),
      `expected ${SAMPLE}-1.1.0 in ${entries.join(', ')}`,
    );

    const sample = (await api()).state?.artifacts.find((a) => a.id === SAMPLE);
    assert.equal(sample?.installedVersion, '1.1.0');
    assert.equal(sample?.status, 'up-to-date');
  });
});
