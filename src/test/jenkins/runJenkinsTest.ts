/**
 * `npm run test:jenkins`: Leuchtturm against a real Jenkins in Docker (the one from
 * `npm run full-sandbox`). Every step a user takes, with builds started through the Jenkins
 * API instead of the "Build Now" button:
 *
 *  1. the job has no builds yet: "Add Source" explains that no .vsix is archived;
 *  2. build #1 → "Add Source" with the job link finds leuchtturm-demo.jenkins 1.1.0;
 *  3. build #2 → the same source now lists 1.2.0 and 1.1.0;
 *  4. the downloaded 1.2.0 passes Leuchtturm's manifest check and installs into VS Code.
 *
 * Needs Docker (and internet the first time, for the Jenkins plugins).
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';

import { discover } from '../../sourceEditor/discover';
import { NEVER_CANCELLED } from '../../util/cancellation';
import { verifyVsix } from '../../util/vsix';
import { JENKINS_EXTENSION_ID, startJenkins } from '../dockerJenkins';
import { draftSource, listDraft } from '../listDraft';
import { removeTempDir } from '../paths';

const step = (text: string) => console.log(`- ${text}`); // eslint-disable-line no-console

async function main(): Promise<void> {
  process.exitCode = 1;
  const jenkins = await startJenkins(step);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-jenkins-'));
  try {
    const look = () => discover(jenkins.jobUrl, { list: listDraft });

    step('no builds yet: "Add Source" says that nothing is archived');
    const empty = await look();
    assert.equal(empty.kind, 'problem');
    assert.match(empty.kind === 'problem' ? empty.message : '', /archived a \.vsix/);

    step('build #1 packages 1.1.0; "Add Source" with the job link finds it');
    assert.deepEqual(await jenkins.build(), { number: 1, result: 'SUCCESS' });
    const first = await look();
    assert.equal(first.kind, 'found', JSON.stringify(first));
    if (first.kind !== 'found') {
      return;
    }
    assert.equal(first.what, 'Jenkins job "demo-extension"');
    assert.deepEqual(first.extensions, [{ id: JENKINS_EXTENSION_ID, versions: ['1.1.0'] }]);

    step('build #2 packages 1.2.0; the saved source lists both versions');
    assert.deepEqual(await jenkins.build(), { number: 2, result: 'SUCCESS' });
    const source = draftSource('jenkins', first.source);
    const [artifact] = await source.list(NEVER_CANCELLED);
    assert.deepEqual(
      artifact?.versions.map((v) => v.version),
      ['1.2.0', '1.1.0'],
    );

    step('the downloaded 1.2.0 passes the manifest check');
    const file = await source.download(artifact!, artifact!.versions[0]!, tmp, NEVER_CANCELLED);
    assert.deepEqual(await verifyVsix(file, JENKINS_EXTENSION_ID, '1.2.0'), {
      ok: true,
      manifest: expectManifest(),
    });

    step('VS Code installs it (the .vsix is built with `jar` in the pipeline)');
    const exe = await downloadAndUnzipVSCode();
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
    const profile = [
      '--user-data-dir',
      path.join(tmp, 'u'),
      '--extensions-dir',
      path.join(tmp, 'e'),
    ];
    const r = spawnSync(cli!, [...cliArgs, ...profile, '--install-extension', file], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(
      (await fs.readdir(path.join(tmp, 'e'))).some((d) =>
        d.startsWith(`${JENKINS_EXTENSION_ID}-1.2.0`),
      ),
      'extension folder missing',
    );

    console.log('Jenkins test passed.'); // eslint-disable-line no-console
    process.exitCode = 0;
  } finally {
    jenkins.close();
    await removeTempDir(tmp);
  }
}

function expectManifest() {
  return {
    publisher: 'leuchtturm-demo',
    name: 'jenkins',
    version: '1.2.0',
    id: JENKINS_EXTENSION_ID,
    displayName: 'Leuchtturm Demo Jenkins',
  };
}

// 'beforeExit' fires when nothing is left to wait for. If the test has not finished by then, a
// request was dropped without an error; say so instead of exiting silently with code 1.
process.once('beforeExit', () => {
  if (process.exitCode !== 0) {
    // eslint-disable-next-line no-console
    console.error('Jenkins test failed: it stopped before finishing (a request never answered).');
  }
});

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Jenkins test failed:', err);
  process.exit(1);
});
