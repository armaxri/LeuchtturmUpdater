import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import type { CheckState } from '../../../checker';
import type { LeuchtturmApi } from '../../../extension';
import { HELPER_COMMAND, HELPER_ID, parseHelperResponse } from '../../../helper/protocol';
import { INSTALL_HELPER_COMMAND } from '../../../targets/remoteExtensions';
import { containerExtensions } from '../../devContainer';
import { IDS } from '../../scenario';

const workspace = (): string => {
  const dir = process.env.LEUCHTTURM_IT_HOST_WORKSPACE;
  assert.ok(dir, 'LEUCHTTURM_IT_HOST_WORKSPACE not set');
  return dir;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `probe` returns something truthy (installs finish asynchronously). */
async function eventually<T>(
  what: string,
  probe: () => T | PromiseLike<T>,
  ms = 60_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let result: T | undefined;
    try {
      result = await probe();
    } catch {
      result = undefined;
    }
    if (result) {
      return result;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await sleep(500);
  }
}

async function api(): Promise<LeuchtturmApi> {
  const ext = vscode.extensions.getExtension<LeuchtturmApi>('armaxri.leuchtturm-updater');
  assert.ok(ext, 'Leuchtturm extension not found');
  return ext.activate();
}

const find = (state: CheckState | undefined, id: string) =>
  state?.artifacts.find((a) => a.id === id);

const helperProblem = (state: CheckState | undefined) =>
  state?.problems.find((p) => p.action?.command === INSTALL_HELPER_COMMAND);

describe('Leuchtturm in a Dev Containers window', () => {
  let leuchtturm: LeuchtturmApi;

  before(async () => {
    // The window opens before the container is ready; wait until the workspace answers.
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(folder, 'no workspace folder');
    await eventually('the dev container', () => vscode.workspace.fs.stat(folder), 280_000);
    leuchtturm = await api();
  });

  it('runs on the local side', () => {
    assert.equal(vscode.env.remoteName, 'dev-container');
    const self = vscode.extensions.getExtension('armaxri.leuchtturm-updater');
    assert.equal(self?.extensionKind, vscode.ExtensionKind.UI);
  });

  it('reaches the sources from the local machine (share, HTTPS through the proxy)', async () => {
    const state = await leuchtturm.checkNow();
    assert.equal(find(state, IDS.hello)?.latest?.version, '1.1.0');
    assert.equal(find(state, IDS.web)?.latest?.version, '0.3.0');
  });

  it('asks for the helper, because container-side extensions are invisible without it', async () => {
    const state = await leuchtturm.checkNow();
    assert.match(helperProblem(state)?.message ?? '', /installed in the dev container/);
    assert.equal(find(state, IDS.hello)?.status, 'not-installed');
  });

  it('installs extensions into the container', async () => {
    await vscode.commands.executeCommand('leuchtturm.installVersion', IDS.hello, '1.0.0');
    await eventually('hello 1.0.0 in the container', () =>
      containerExtensions(workspace()).includes(`${IDS.hello}-1.0.0`),
    );
  });

  it('installs the helper on click, into the container', async () => {
    await vscode.commands.executeCommand(INSTALL_HELPER_COMMAND);
    assert.ok(
      containerExtensions(workspace()).some((name) => name.startsWith(`${HELPER_ID}-`)),
      'helper not in the container',
    );
    const answer = parseHelperResponse(await vscode.commands.executeCommand(HELPER_COMMAND));
    assert.ok(answer, 'helper does not answer');
    assert.ok(answer.extensions.some((e) => e.id === IDS.hello && e.version === '1.0.0'));
    assert.equal(helperProblem(leuchtturm.state), undefined);
  });

  it('sees versions installed in the container by other means', async () => {
    // As if installed through the Extensions view: Leuchtturm is not involved.
    const world = (await leuchtturm.checkNow())?.artifacts.find((a) => a.id === IDS.world);
    const file = world?.latest?.available.ref.path;
    assert.ok(file, 'world has no file path');
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(file),
    );
    const state = await eventually('world as installed', async () => {
      const s = await leuchtturm.checkNow();
      return find(s, IDS.world)?.installedVersion === '0.5.0' ? s : undefined;
    });
    assert.equal(find(state, IDS.world)?.status, 'up-to-date');
    assert.equal(find(state, IDS.hello)?.status, 'update');
  });

  it('updates an extension in the container', async () => {
    await vscode.commands.executeCommand('leuchtturm.installVersion', IDS.hello, '1.1.0');
    await eventually('hello 1.1.0 in the container', () =>
      containerExtensions(workspace()).includes(`${IDS.hello}-1.1.0`),
    );
    assert.equal(find(leuchtturm.state, IDS.hello)?.status, 'up-to-date');
  });
});
