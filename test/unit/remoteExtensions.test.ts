import { describe, expect, it } from 'vitest';

import { HELPER_PROTOCOL, parseHelperResponse } from '../../src/helper/protocol';
import {
  INSTALL_HELPER_COMMAND,
  RemoteExtensions,
  remoteLabel,
  type RemoteHost,
} from '../../src/targets/remoteExtensions';

const answer = (helperVersion: string, extensions: unknown[] = []) => ({
  protocol: HELPER_PROTOCOL,
  helperVersion,
  extensions,
});

function host(remoteName: string | undefined, query: () => Promise<unknown>): RemoteHost {
  return { remoteName: () => remoteName, query };
}

describe('parseHelperResponse', () => {
  it('accepts a valid answer and drops malformed entries', () => {
    expect(
      parseHelperResponse(
        answer('1.0.0', [
          { id: 'a.b', version: '1.0.0', displayName: 'A B' },
          { id: 'c.d', version: '2.0.0', displayName: 5 },
          { id: 'no.version' },
          'junk',
          null,
        ]),
      ),
    ).toEqual(
      answer('1.0.0', [
        { id: 'a.b', version: '1.0.0', displayName: 'A B' },
        { id: 'c.d', version: '2.0.0' },
      ]),
    );
  });

  it.each([undefined, null, 'x', {}, { ...answer('1.0.0'), protocol: 2 }, { protocol: 1 }])(
    'rejects %j',
    (value) => {
      expect(parseHelperResponse(value)).toBeUndefined();
    },
  );
});

describe('RemoteExtensions', () => {
  it('does nothing in a local window', async () => {
    let asked = false;
    const remote = new RemoteExtensions(
      host(undefined, () => {
        asked = true;
        return Promise.resolve(answer('1.0.0'));
      }),
      '1.0.0',
    );
    expect(await remote.refresh()).toBe('local');
    expect(asked).toBe(false);
    expect(remote.problem()).toBeUndefined();
  });

  it('reports a missing helper with an install action', async () => {
    const remote = new RemoteExtensions(
      host('dev-container', () => Promise.reject(new Error("command '…' not found"))),
      '1.0.0',
    );
    expect(await remote.refresh()).toBe('missing');
    expect(remote.problem()).toEqual({
      message:
        'Extensions installed in the dev container are not visible yet. Click to install the ' +
        'Leuchtturm helper there.',
      action: { title: 'Install Helper…', command: INSTALL_HELPER_COMMAND },
    });
  });

  it('looks up remote extensions case-insensitively', async () => {
    const remote = new RemoteExtensions(
      host('ssh-remote', () =>
        Promise.resolve(
          answer('1.0.0', [{ id: 'Corp.Linter', version: '1.4.0', displayName: 'Corp Linter' }]),
        ),
      ),
      '1.0.0',
    );
    expect(await remote.refresh()).toBe('ok');
    expect(remote.get('corp.linter')).toEqual({
      id: 'Corp.Linter',
      version: '1.4.0',
      displayName: 'Corp Linter',
    });
    expect(remote.problem()).toBeUndefined();
  });

  it('asks to update an older helper but still uses its answer', async () => {
    const remote = new RemoteExtensions(
      host('wsl', () => Promise.resolve(answer('1.0.0', [{ id: 'a.b', version: '2.0.0' }]))),
      '1.1.0',
    );
    expect(await remote.refresh()).toBe('outdated');
    expect(remote.get('a.b')?.version).toBe('2.0.0');
    expect(remote.problem()?.message).toBe(
      'The Leuchtturm helper in WSL is outdated. Click to update it.',
    );
    expect(remote.problem()?.action?.title).toBe('Update Helper…');
  });

  it('forgets remote versions when the helper stops answering', async () => {
    let up = true;
    const remote = new RemoteExtensions(
      host('dev-container', () =>
        up
          ? Promise.resolve(answer('1.0.0', [{ id: 'a.b', version: '1.0.0' }]))
          : Promise.resolve(undefined),
      ),
      '1.0.0',
    );
    await remote.refresh();
    up = false;
    expect(await remote.refresh()).toBe('missing');
    expect(remote.get('a.b')).toBeUndefined();
  });

  it('names unknown remotes generically', () => {
    expect(remoteLabel('k8s-container')).toBe('the remote side (k8s-container)');
  });
});
