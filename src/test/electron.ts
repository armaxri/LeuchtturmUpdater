/**
 * Drives the downloaded test copy of VS Code with Playwright's Electron support. Shared by
 * `npm run screenshots` and `npm run test:ui`. Only that window is touched, never the rest of
 * the screen, and it is always closed again.
 */

import { spawnSync } from 'node:child_process';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import {
  _electron as electron,
  type ElectronApplication,
  type FrameLocator,
  type Page,
} from 'playwright-core';

import { ROOT } from './paths';
import type { Scenario } from './scenario';

export interface Workbench {
  app: ElectronApplication;
  page: Page;
}

/** Starts VS Code on the scenario with Leuchtturm's development build and waits for it. */
export async function launchWorkbench(
  scenario: Scenario,
  size = { width: 1180, height: 720 },
): Promise<Workbench> {
  const executablePath = await downloadAndUnzipVSCode();
  const profile = [
    '--user-data-dir',
    scenario.userDataDir,
    '--extensions-dir',
    scenario.extensionsDir,
  ];
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executablePath);
  for (const vsix of scenario.preinstall) {
    spawnSync(cli!, [...cliArgs, ...profile, '--install-extension', vsix], {
      shell: process.platform === 'win32',
    });
  }
  const app = await electron.launch({
    executablePath,
    args: [
      scenario.workspace,
      ...profile,
      `--extensionDevelopmentPath=${ROOT}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
    ],
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height);
    }, size);
    await page.waitForTimeout(1500);
    return { app, page };
  } catch (err) {
    await app.close();
    throw err;
  }
}

/** Runs a command through the command palette, by its title. */
export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').fill(`>${title}`);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}

/**
 * The content of the webview whose tab is active. VS Code nests two frames: the outer one
 * hosts the webview, the inner one (`#active-frame`) holds the page.
 */
export function activeWebview(page: Page): FrameLocator {
  return page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
}
