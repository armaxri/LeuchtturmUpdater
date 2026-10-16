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
import { removeTempDir, ROOT } from '../paths';
import { buildScenario } from '../scenario';

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
  try {
    step('starting VS Code');
    const { app, page } = await launchWorkbench(scenario, { width: 1400, height: 900 });
    try {
      step('the Leuchtturm view has an "Add Source…" button; it asks for a link');
      await runCommand(page, 'View: Show Leuchtturm');
      await page.locator('.part.sidebar [aria-label^="Add Source"]').first().click();
      const form = activeWebview(page);
      const lookUp = async (input: string) => {
        await form.locator('#discover-input').fill(input);
        await form.locator('#discover-run').click();
        await form.locator('#discover-result').waitFor();
      };

      step('pasting the "Last Successful Artifacts" link of a Jenkins job finds its extension');
      await lookUp(`${scenario.jenkinsUrl}/job/demo-ci/lastSuccessfulBuild/artifact/`);
      await form.getByText('Found 1 extension').waitFor();
      await form.locator('#discover-result').getByText('leuchtturm-demo.ci').waitFor();
      await form.locator('#discover-result td', { hasText: '2.1.0' }).waitFor();
      await form.getByText(/older versions can be installed too/).waitFor();
      assert.equal(await form.locator('#discover-name').inputValue(), 'demo-ci');

      step('saving it writes a complete http source, no regex typed by the user');
      await form.locator('#discover-save').click();
      await form.locator('h1', { hasText: 'demo-ci' }).waitFor();
      await eventually('the source in settings.json', async () => {
        const saved = (await userSources(scenario.userDataDir))['demo-ci'] as
          { type?: string; match?: { jsonPath?: string }; download?: { url?: string } } | undefined;
        assert.equal(saved?.type, 'http');
        assert.equal(saved?.match?.jsonPath, '$.builds[*].artifacts[*]');
        assert.match(saved?.download?.url ?? '', /\/job\/demo-ci\/\$\{number\}\/artifact\//);
      });
      // The other sources are untouched and keep their order.
      const names = Object.keys(await userSources(scenario.userDataDir));
      assert.deepEqual(names.slice(0, 2), ['share', 'offline']);
      assert.equal(names.at(-1), 'demo-ci');

      step('Test on the saved source lists what it finds');
      await form.locator('#test').click();
      await form
        .locator('#test-text')
        .getByText(/matched {2}leuchtturm-demo\.ci 2\.1\.0/)
        .waitFor();

      step('a Jenkins that needs a login points to script sources');
      await form.locator('#add-source').click();
      await lookUp(scenario.protectedJenkinsUrl);
      await form.getByText(/needs a login/).waitFor();
      await form.getByText(/does not handle logins or passwords/).waitFor();
      await form.getByRole('button', { name: 'Set Up a Script Source' }).waitFor();

      step('a folder works too, and the suggested name is never taken');
      await lookUp(scenario.share);
      await form.getByText(/Found \d+ extensions/).waitFor();
      assert.equal(await form.locator('#discover-name').inputValue(), 'share-2');

      step('text that is no link explains what to paste');
      await lookUp('just some words');
      await form.getByText(/is not a link, a folder or an npm package name/).waitFor();

      step('an existing source opens in the detailed form');
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
      // No credential fields anywhere.
      assert.equal(await form.locator('[id^="field-auth"], [id^="auth-"]').count(), 0);

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
      await form.getByRole('button', { name: 'Keep Editing' }).click();
      assert.equal(await form.locator('#field-index-url').inputValue(), 'https://changed.example/');
      await form.getByRole('button', { name: 'Revert' }).click();

      step('"Edit Source" on a problem node opens that source');
      await runCommand(page, 'Leuchtturm: Check for Updates');
      const problem = page
        .locator('.part.sidebar .monaco-list-row', { hasText: 'offline' })
        .first();
      // The inline pencil button (context menus are native on macOS, out of Playwright's reach).
      // The check started above redraws the tree when it finishes, which can swallow a click
      // that lands on a row being replaced; so hover, click and look for the form until it opens.
      await eventually(
        'the form for "offline"',
        async () => {
          await problem.hover({ timeout: 2_000 });
          await problem
            .locator('.action-label[aria-label="Edit Source"]')
            .click({ timeout: 2_000 });
          await form.locator('h1', { hasText: 'offline' }).waitFor({ timeout: 2_000 });
        },
        30_000,
      );

      step('deleting asks for confirmation (modal dialog, answered with Delete)');
      await form.locator('[data-source="demo-ci"]').click();
      await form.getByRole('button', { name: 'Delete' }).click();
      await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Delete' }).click();
      await eventually('the source removed from settings.json', async () => {
        assert.equal((await userSources(scenario.userDataDir))['demo-ci'], undefined);
      });

      step('the Settings page links to the form');
      await runCommand(page, 'Leuchtturm: Open Settings');
      const link = page.locator('.settings-editor a', { hasText: 'Add or edit sources in a form' });
      await link.first().waitFor();
      await link.first().click();
      await page.locator('.tab.active', { hasText: 'Leuchtturm Sources' }).waitFor();
    } catch (err) {
      // A picture of the window says more than a timeout message.
      // In the repository, so that CI can upload it (.test-failures/ is ignored by git).
      const shot = path.join(ROOT, '.test-failures', 'ui.png');
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
    await removeTempDir(tmp);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('UI test failed:', err);
  process.exit(1);
});
