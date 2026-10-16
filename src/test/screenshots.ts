/**
 * `npm run screenshots`: renders the README screenshots from the demo scenario. Drives the
 * downloaded test copy of VS Code with Playwright's Electron support and captures only that
 * window (never the rest of the screen). Output: docs/images/*.png.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import { _electron as electron, type Page } from 'playwright-core';

import { ROOT } from './paths';
import { buildScenario, IDS } from './scenario';

const OUT = path.join(ROOT, 'docs/images');

async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.locator('.quick-input-widget input').fill(`>${title}`);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}

/** Drags the sash on the side bar's right edge (the commands depend on focus). */
async function widenSidebar(page: Page, by: number): Promise<void> {
  const bar = await page.locator('.part.sidebar').boundingBox();
  if (!bar) {
    throw new Error('side bar not found');
  }
  const edge = bar.x + bar.width;
  for (const sash of await page.locator('.monaco-sash.vertical').all()) {
    const box = await sash.boundingBox();
    if (box && Math.abs(box.x + box.width / 2 - edge) < 8 && box.height > bar.height / 2) {
      const y = box.y + box.height / 2;
      await sash.hover();
      await page.mouse.down();
      await page.mouse.move(edge + by / 2, y, { steps: 5 });
      await page.mouse.move(edge + by, y, { steps: 5 });
      await page.mouse.up();
      return;
    }
  }
  throw new Error(`no sash at the side bar edge (x=${edge})`);
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'leuchtturm-shots-'));
  // A tidy demo: no deliberately broken sources besides the missing credential.
  const scenario = await buildScenario(
    path.join(tmp, 's'),
    {
      'leuchtturm.checkOnStartup': true,
      'workbench.colorTheme': 'Default Dark Modern',
      'window.zoomLevel': 0,
      'window.titleBarStyle': 'custom',
      'workbench.layoutControl.enabled': false,
      'chat.commandCenter.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      // Only the meaningful demos; the deliberately broken files stay out of the picture.
      'leuchtturm.trackAllFromSources': false,
      'leuchtturm.extensions': [IDS.hello, IDS.registry, IDS.world, IDS.web, IDS.packed],
    },
    ['offline', 'script'],
  );
  try {
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

    const step = (text: string) => console.log(`- ${text}`); // eslint-disable-line no-console
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
      step('waiting for the workbench');
      const page = await app.firstWindow();
      page.setDefaultTimeout(30_000);
      await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 720);
      });
      await page.waitForTimeout(1500);

      // The startup check runs ~10 s after activation and announces the updates.
      step('waiting for the update notification');
      const toast = page.locator('.notification-toast', { hasText: 'Leuchtturm' });
      await toast.first().waitFor({ timeout: 40_000 });
      await page.waitForTimeout(500);
      await toast.first().screenshot({ path: path.join(OUT, 'notification.png') });

      step('opening the Leuchtturm view');
      await runCommand(page, 'View: Show Leuchtturm');
      await page.getByText('Updates available').first().waitFor({ timeout: 20_000 });
      // Widen the sidebar so versions and source names are not cut off.
      step('widening the sidebar');
      await widenSidebar(page, 150);
      await page.mouse.move(900, 400); // un-hover the sash
      // Close notifications so the tree is unobstructed.
      await runCommand(page, 'Notifications: Clear All Notifications');
      await page.waitForTimeout(800);
      step('capturing');
      // Side bar plus the left end of the status bar, where Leuchtturm's item sits.
      const bar = (await page.locator('.part.sidebar').boundingBox())!;
      const height = page.viewportSize()?.height ?? 720;
      await page.screenshot({
        path: path.join(OUT, 'sidebar.png'),
        clip: { x: 0, y: 0, width: bar.x + bar.width + 40, height },
      });
    } finally {
      // Never leave the VS Code test window open, even after a failure.
      await app.close();
    }
    // eslint-disable-next-line no-console
    console.log(`Screenshots written to ${path.relative(ROOT, OUT)}/`);
  } finally {
    await scenario.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
