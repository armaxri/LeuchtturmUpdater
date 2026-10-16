import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConfig, type ScriptSourceConfig } from '../../src/config';
import { NULL_LOGGER } from '../../src/log';
import {
  parseScriptOutput,
  scriptFingerprint,
  ScriptSource,
  type ScriptGate,
} from '../../src/sources/scriptSource';
import { ActionableError } from '../../src/sources/types';
import { ROOT } from '../../src/test/paths';
import { CancellationSource, NEVER_CANCELLED } from '../../src/util/cancellation';
import type { JsonSchema } from '../../src/util/jsonSchema';
import { settings, tempDir } from './helpers';

const schema = JSON.parse(
  readFileSync(path.join(ROOT, 'schemas/script-protocol.schema.json'), 'utf8'),
) as JsonSchema;

/** A fake script in JavaScript, run with this Node binary: portable and fast. */
async function fakeScript(body: string): Promise<string> {
  const file = path.join(await tempDir(), 'fake.js');
  await fs.writeFile(
    file,
    `const action = process.argv[2];\nconst out = (o) => console.log(JSON.stringify({ protocol: 1, ...o }));\n${body}`,
  );
  return file;
}

function make(
  script: string,
  extra: Record<string, unknown> = {},
  gate: Partial<ScriptGate> = {},
  timeoutMs = 5000,
) {
  const config = parseConfig(
    settings({
      'script.enabled': true,
      sources: { custom: { type: 'script', command: process.execPath, script, ...extra } },
    }),
    { env: { CUSTOM_SOURCE: 'from-env' } },
  );
  expect(config.problems).toEqual([]);
  const requested: string[] = [];
  const src = new ScriptSource(config.sources[0] as ScriptSourceConfig, timeoutMs, NULL_LOGGER, {
    gate: {
      enabled: () => true,
      isApproved: () => true,
      requestApproval: (_n, _f, cmd) => requested.push(cmd),
      ...gate,
    },
    schema,
    hostVersion: '1.99.0',
  });
  return { src, requested };
}

const LIST = `if (action === 'get_versions') out({ artifacts: [{ id: 'corp.x', versions: [
  { version: '1.0.0', ref: { build: '7', 'my-key': 'a b' } },
  { version: '1.1.0', sha256: '${'A'.repeat(64)}' } ] }] });`;

describe('ScriptSource', () => {
  it('lists artifacts and passes context in args and environment', async () => {
    const script = await fakeScript(`${LIST}
if (action === 'download_version') {
  const fs = require('fs'), path = require('path');
  const dir = process.argv[process.argv.indexOf('--target-dir') + 1];
  const file = path.join(dir, 'out.vsix');
  fs.writeFileSync(file, JSON.stringify({ argv: process.argv.slice(2), env: {
    p: process.env.LEUCHTTURM_PROTOCOL, a: process.env.LEUCHTTURM_ACTION, id: process.env.LEUCHTTURM_ID,
    v: process.env.LEUCHTTURM_VERSION, vs: process.env.LEUCHTTURM_VSCODE_VERSION,
    b: process.env.LEUCHTTURM_REF_BUILD, k: process.env.LEUCHTTURM_REF_MY_KEY, custom: process.env.CUSTOM } }));
  out({ path: file });
}`);
    const { src } = make(script, {
      env: { CUSTOM: '${env:CUSTOM_SOURCE}' },
      args: {
        download: [
          'download_version',
          '--target-dir',
          '${targetDir}',
          '--build',
          '${ref.build}',
          '$(echo nope)',
        ],
      },
    });
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(artifact!.versions.map((v) => [v.version, v.sha256, v.releaseNotesOnDemand])).toEqual([
      ['1.1.0', 'a'.repeat(64), true],
      ['1.0.0', undefined, true],
    ]);
    const dir = await tempDir();
    const file = await src.download(artifact!, artifact!.versions[1]!, dir, NEVER_CANCELLED);
    expect(path.dirname(file)).toBe(dir);
    const seen = JSON.parse(await fs.readFile(file, 'utf8')) as { argv: string[]; env: object };
    // No shell: `$(echo nope)` arrives literally.
    expect(seen.argv).toEqual([
      'download_version',
      '--target-dir',
      dir,
      '--build',
      '7',
      '$(echo nope)',
    ]);
    expect(seen.env).toEqual({
      p: '1',
      a: 'download',
      id: 'corp.x',
      v: '1.0.0',
      vs: '1.99.0',
      b: '7',
      k: 'a b',
      custom: 'from-env',
    });
  });

  it('copies a returned path outside the download folder instead of using it', async () => {
    const outside = path.join(await tempDir(), 'keep.vsix');
    await fs.writeFile(outside, 'mine');
    const script = await fakeScript(
      `${LIST}\nif (action === 'download_version') out({ path: ${JSON.stringify(outside)} });`,
    );
    const { src } = make(script);
    const [artifact] = await src.list(NEVER_CANCELLED);
    const dir = await tempDir();
    const file = await src.download(artifact!, artifact!.versions[0]!, dir, NEVER_CANCELLED);
    expect(file).toBe(path.join(dir, 'corp.x-1.1.0.vsix'));
    expect(await fs.readFile(outside, 'utf8')).toBe('mine');
  });

  it('refuses to run while the gate is off or the script is not approved', async () => {
    const script = await fakeScript(LIST);
    const off = make(script, {}, { enabled: () => false });
    await expect(off.src.list(NEVER_CANCELLED)).rejects.toThrow(/Script sources are disabled/);

    const pending = make(script, {}, { isApproved: () => false });
    const err = await pending.src.list(NEVER_CANCELLED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect((err as ActionableError).action.command).toBe('leuchtturm.approveScript');
    expect(pending.requested).toEqual([`${process.execPath} ${script}`]);
  });

  it('reports exit codes, error responses and invalid output clearly', async () => {
    const cases: [string, RegExp][] = [
      [
        `console.error('boom: server down'); process.exit(2);`,
        /exited with code 2: boom: server down/,
      ],
      [
        `out({ error: 'Artifact server unreachable', detail: 'ECONNREFUSED' }); process.exit(1);`,
        /^Artifact server unreachable$/,
      ],
      [
        `out({ artifacts: [{ id: 'bad', versions: [] }] });`,
        /Invalid response to "list": artifacts\[0\]\.id/,
      ],
      [`console.log('not json');`, /stdout is not JSON/],
      [``, /printed nothing/],
    ];
    for (const [body, message] of cases) {
      const { src } = make(await fakeScript(body));
      await expect(src.list(NEVER_CANCELLED), body).rejects.toThrow(message);
    }
  });

  it('uses the last JSON line when a script prints extra output', async () => {
    const { src } = make(await fakeScript(`console.log('debug output'); ${LIST}`));
    expect((await src.list(NEVER_CANCELLED))[0]!.id).toBe('corp.x');
  });

  it('handles release notes and "not supported"', async () => {
    const script = await fakeScript(`${LIST}
if (action === 'get_release_notes') { if (process.argv.includes('1.1.0')) out({ markdown: '## 1.1.0' }); else process.exit(3); }`);
    const { src } = make(script);
    const [artifact] = await src.list(NEVER_CANCELLED);
    expect(await src.fetchReleaseNotes(artifact!, artifact!.versions[0]!, NEVER_CANCELLED)).toBe(
      '## 1.1.0',
    );
    expect(
      await src.fetchReleaseNotes(artifact!, artifact!.versions[1]!, NEVER_CANCELLED),
    ).toBeUndefined();

    const { src: noNotes } = make(script, { args: { notes: null } });
    const [a2] = await noNotes.list(NEVER_CANCELLED);
    expect(a2!.versions[0]!.releaseNotesOnDemand).toBe(false);
  });

  it('kills the script on timeout and cancellation', async () => {
    const script = await fakeScript(`setInterval(() => {}, 1000);`);
    const { src } = make(script, {}, {}, 300);
    await expect(src.list(NEVER_CANCELLED)).rejects.toThrow(/Timed out/);
    const cts = new CancellationSource();
    const { src: slow } = make(script);
    const pending = slow.list(cts.token);
    setTimeout(() => cts.cancel(), 100);
    await expect(pending).rejects.toThrow(/Cancelled/);
  });

  it('reports a missing command', async () => {
    const config = parseConfig(
      settings({
        'script.enabled': true,
        sources: { s: { type: 'script', command: 'leuchtturm-no-such-cmd' } },
      }),
    );
    const src = new ScriptSource(config.sources[0] as ScriptSourceConfig, 5000, NULL_LOGGER, {
      gate: { enabled: () => true, isApproved: () => true, requestApproval: () => undefined },
      schema,
      hostVersion: '1',
    });
    await expect(src.list(NEVER_CANCELLED)).rejects.toThrow(
      /Command not found: "leuchtturm-no-such-cmd"/,
    );
  });
});

describe('script config and gate', () => {
  it('keeps script sources out unless the user setting enables them', () => {
    const raw = { sources: { s: { type: 'script', command: 'python3' } } };
    const off = parseConfig(settings(raw));
    expect(off.sources).toEqual([]);
    expect(off.problems).toEqual([
      expect.objectContaining({
        source: 's',
        message: expect.stringMatching(/Script sources are disabled/),
        action: expect.objectContaining({ command: 'workbench.action.openGlobalSettings' }),
      }),
    ]);
    expect(parseConfig(settings({ ...raw, 'script.enabled': true })).sources).toHaveLength(1);
  });

  it('validates argument templates per action', () => {
    const bad = parseConfig(
      settings({
        'script.enabled': true,
        sources: { s: { type: 'script', command: 'x', args: { list: ['--v', '${version}'] } } },
      }),
    );
    expect(bad.problems[0]?.message).toMatch(/args.list" uses \$\{version\}/);
  });

  it('fingerprints command and script path', () => {
    const a = scriptFingerprint({ command: 'python3', script: '/a.py' });
    expect(scriptFingerprint({ command: 'python3', script: '/a.py' })).toBe(a);
    expect(scriptFingerprint({ command: 'python3', script: '/b.py' })).not.toBe(a);
    expect(scriptFingerprint({ command: 'python', script: '/a.py' })).not.toBe(a);
  });

  it('parses stdout strictly but tolerates log lines before the JSON', () => {
    expect(parseScriptOutput('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseScriptOutput('hello\n{"a":1}\n').warning).toMatch(/more than one/);
    expect(() => parseScriptOutput('hello')).toThrow(/not JSON/);
  });
});
