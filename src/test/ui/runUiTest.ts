/**
 * `npm run test:ui`: clicks through the source editor (a webview) in the downloaded VS Code,
 * the way a user would. Webviews are out of reach for the mocha integration tests, which run
 * inside the extension host; Playwright drives the real window instead.
 *
 * Each step prints what it checks; the first failure stops the run with a non-zero exit code.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { activeWebview, launchWorkbench, runCommand } from '../electron';
import { buildScenario, JENKINS_SECRET } from '../scenario';

const step = (text: string) => console.log(`- ${text}`); // eslint-disable-line no-console

async function userSources(userDataDir: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(path.join(userDataDir, 'User', 'settings.json'), 'utf8');
  return (JSON.parse(text) as { 'leuchtturm.sources': Record<string, unknown> })[
    'leuchtturm.sources'
  ];
}

/** Polls until `check` passes (settings are written asynchronously). */
async function eventually(what: string, check: () => Promise<void>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > end) {
        throw new Error(`Timed out: ${what}`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function main(): Promise<void> {
  process.exitCode = 1;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-ui-'));
  const scenario = await buildScenario(path.join(tmp, 's'), {
    'leuchtturm.checkOnStartup': false,
    'leuchtturm.notify': false,
    // VS Code's own dialogs instead of native ones (macOS), so Playwright can answer them.
    'window.dialogStyle': 'custom',
  });
  const extraShare = path.join(scenario.root, 'team-share');
  await fs.mkdir(extraShare);
  try {
    step('starting VS Code');
    const { app, page } = await launchWorkbench(scenario, { width: 1400, height: 900 });
    try {
      step('the Leuchtturm view has an "Add Source…" button');
      await runCommand(page, 'View: Show Leuchtturm');
      await page.locator('.part.sidebar [aria-label^="Add Source"]').first().click();
      const form = activeWebview(page);

      step('adding a file source through the form');
      await form.locator('[data-type="file"]').click();
      await form.locator('#source-name').fill('team-share');
      await form.locator('#field-path').fill(extraShare);
      await form.locator('#field-recursive').check();
      await form.locator('#save:not([disabled])').click();
      await form.getByText('Saved "team-share" to your user settings.').waitFor();
      await eventually('the source in settings.json', async () => {
        assert.deepEqual((await userSources(scenario.userDataDir))['team-share'], {
          type: 'file',
          path: extraShare,
          recursive: true,
        });
      });
      // The other sources are untouched and keep their order.
      const names = Object.keys(await userSources(scenario.userDataDir));
      assert.deepEqual(names.slice(0, 2), ['share', 'offline']);
      assert.equal(names.at(-1), 'team-share');

      step('testing the saved source shows the listing inline');
      await form.locator('#test').click();
      await form.locator('#test-text').getByText('Nothing found.').waitFor();

      step('opening an existing http source fills the form, credentials included');
      await form.locator('[data-source="jenkins"]').click();
      assert.match(
        await form.locator('#field-index-url').inputValue(),
        /\/job\/demo-ci\/api\/json/,
      );
      assert.equal(
        await form.locator('#field-match-jsonPath').inputValue(),
        '$.builds[*].artifacts[*]',
      );
      assert.equal(await form.locator('#field-match-where').inputValue(), 'result: SUCCESS');
      assert.ok(await form.locator('#auth-basic').isChecked());
      assert.equal(
        await form.locator('#field-auth-basic-password').inputValue(),
        `\${secret:${JENKINS_SECRET.name}}`,
      );
      await form.getByText(`The credential "${JENKINS_SECRET.name}" is not stored yet`).waitFor();

      step('an invalid edit is reported and cannot be saved; Revert restores it');
      await form.locator('#field-download-url').fill('');
      await form.getByText(/"download(\.url)?" is required/).waitFor();
      assert.ok(await form.locator('#save').isDisabled());
      await form.getByRole('button', { name: 'Revert' }).click();
      assert.match(await form.locator('#field-download-url').inputValue(), /artifact/);

      step('unsaved changes are not lost by clicking another source');
      await form.locator('#field-index-url').fill('https://changed.example/');
      await form.locator('[data-source="share"]').click();
      await form.getByText('This source has unsaved changes.').waitFor();
      await form.getByRole('button', { name: 'Keep editing' }).click();
      assert.equal(await form.locator('#field-index-url').inputValue(), 'https://changed.example/');
      await form.getByRole('button', { name: 'Revert' }).click();

      step('switching credentials to a token keeps the form consistent');
      await form.locator('#auth-bearer').check();
      await form.locator('#field-auth-bearer').fill('${secret:ci-token}');
      await form.getByText('The credential "ci-token" is not stored yet').waitFor();
      await form.getByRole('button', { name: 'Revert' }).click();

      step('"Edit Source" on a problem node opens that source');
      await runCommand(page, 'Leuchtturm: Check for Updates');
      const problem = page
        .locator('.part.sidebar .monaco-list-row', { hasText: 'offline' })
        .first();
      await problem.waitFor();
      // The inline pencil button (context menus are native on macOS, out of Playwright's reach).
      await problem.hover();
      await problem.locator('.action-label[aria-label="Edit Source"]').click();
      await form.locator('h1', { hasText: 'offline' }).waitFor();

      step('deleting asks for confirmation (modal dialog, answered with Delete)');
      await form.locator('[data-source="team-share"]').click();
      await form.getByRole('button', { name: 'Delete' }).click();
      await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Delete' }).click();
      await eventually('the source removed from settings.json', async () => {
        assert.equal((await userSources(scenario.userDataDir))['team-share'], undefined);
      });

      step('the Settings page links to the form');
      await runCommand(page, 'Leuchtturm: Open Settings');
      const link = page.locator('.settings-editor a', { hasText: 'Add or edit sources in a form' });
      await link.first().waitFor();
      await link.first().click();
      await page.locator('.tab.active', { hasText: 'Leuchtturm Sources' }).waitFor();
    } catch (err) {
      // A picture of the window says more than a timeout message.
      const shot = path.join(os.tmpdir(), 'leuchtturm-ui-failure.png');
      await page.screenshot({ path: shot }).catch(() => undefined);
      console.error(`Screenshot of the failure: ${shot}`); // eslint-disable-line no-console
      throw err;
    } finally {
      await app.close();
    }
    // eslint-disable-next-line no-console
    console.log('UI test passed.');
    process.exitCode = 0;
  } finally {
    await scenario.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('UI test failed:', err);
  process.exit(1);
});
