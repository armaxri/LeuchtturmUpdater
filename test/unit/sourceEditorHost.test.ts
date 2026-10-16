import { describe, expect, it } from 'vitest';

import { SourceEditorHost, type EditorDeps } from '../../src/sourceEditor/host';
import type { ToWebview } from '../../src/sourceEditor/protocol';

function setup(initial: Record<string, unknown> = {}, options: { confirm?: boolean } = {}) {
  let sources: Record<string, unknown> = initial;
  const stored = new Set<string>(['jenkins']);
  const posted: ToWebview[] = [];
  const writes: Record<string, unknown>[] = [];
  const deps: EditorDeps = {
    readSources: () => sources,
    writeSources: (next) => {
      sources = next;
      writes.push(next);
      return Promise.resolve();
    },
    isSecretStored: (name) => Promise.resolve(stored.has(name)),
    storeSecret: (name) => {
      stored.add(name);
      return Promise.resolve(true);
    },
    askSecretName: (suggested) => Promise.resolve(`${suggested}-token`),
    confirm: () => Promise.resolve(options.confirm ?? true),
    test: (name) => Promise.resolve(`tested ${name}`),
    scriptEnabled: () => false,
    open: () => undefined,
    post: (m) => posted.push(m),
  };
  return { host: new SourceEditorHost(deps), posted, writes, sources: () => sources };
}

const FILE = { type: 'file', path: '/tmp' };

describe('SourceEditorHost', () => {
  it('sends the user-level sources and which referenced credentials are stored', async () => {
    const { host, posted } = setup({
      ci: { type: 'http', auth: { bearer: '${secret:jenkins}' } },
      nexus: { type: 'npm', auth: { token: '${secret:nexus}' } },
      junk: 'not an object',
    });
    await host.handle({ type: 'ready' });
    expect(posted).toEqual([
      {
        type: 'state',
        focus: undefined,
        state: {
          sources: {
            ci: { type: 'http', auth: { bearer: '${secret:jenkins}' } },
            nexus: { type: 'npm', auth: { token: '${secret:nexus}' } },
          },
          storedSecrets: ['jenkins'],
          scriptEnabled: false,
        },
      },
    ]);
  });

  it('adds a new source at the end and selects it', async () => {
    const { host, posted, sources } = setup({ a: FILE });
    await host.handle({ type: 'save', name: 'b', source: FILE });
    expect(Object.keys(sources())).toEqual(['a', 'b']);
    expect(posted.map((m) => m.type)).toEqual(['state', 'saved']);
    expect(posted[0]).toMatchObject({ focus: { kind: 'source', name: 'b' } });
  });

  it('renames in place, keeping the order and other sources', async () => {
    const { host, sources } = setup({ a: FILE, b: FILE, c: FILE });
    await host.handle({
      type: 'save',
      name: 'b2',
      originalName: 'b',
      source: { ...FILE, recursive: true },
    });
    expect(sources()).toEqual({ a: FILE, b2: { ...FILE, recursive: true }, c: FILE });
  });

  it('keeps sources added elsewhere while the editor was open', async () => {
    const env = setup({ a: FILE });
    // Simulates an edit in settings.json between opening and saving.
    await env.host.handle({ type: 'save', name: 'x', source: FILE });
    await env.host.handle({
      type: 'save',
      name: 'a',
      originalName: 'a',
      source: { ...FILE, path: '/y' },
    });
    expect(env.sources()).toEqual({ a: { ...FILE, path: '/y' }, x: FILE });
  });

  it('refuses invalid sources and duplicate names', async () => {
    const { host, posted, writes } = setup({ a: FILE });
    await host.handle({ type: 'save', name: 'b', source: { type: 'file' } });
    await host.handle({ type: 'save', name: 'a', source: FILE });
    expect(writes).toEqual([]);
    expect(posted).toEqual([
      { type: 'error', message: '"path" is required for a file source' },
      { type: 'error', message: 'There is already a source named "a".' },
    ]);
  });

  it('stores a "__proto__" source as a plain key', async () => {
    const { host, sources } = setup({});
    await host.handle({ type: 'save', name: '__proto__', source: FILE });
    expect(Object.keys(sources())).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(sources())).toBe(Object.prototype);
  });

  it('deletes only after confirmation', async () => {
    const declined = setup({ a: FILE }, { confirm: false });
    await declined.host.handle({ type: 'delete', name: 'a' });
    expect(declined.writes).toEqual([]);
    const confirmed = setup({ a: FILE, b: FILE });
    await confirmed.host.handle({ type: 'delete', name: 'a' });
    expect(confirmed.sources()).toEqual({ b: FILE });
    expect(confirmed.posted.map((m) => m.type)).toEqual(['deleted', 'state']);
  });

  it('validates without counting the source itself as a duplicate', async () => {
    const { host, posted } = setup({ a: FILE });
    await host.handle({
      type: 'validate',
      requestId: 7,
      name: 'a',
      originalName: 'a',
      source: FILE,
    });
    expect(posted).toEqual([
      { type: 'validation', requestId: 7, result: { errors: [], warnings: [] } },
    ]);
  });

  it('stores a new credential and hands its name to the field', async () => {
    const { host, posted } = setup({});
    await host.handle({ type: 'storeSecret', field: 'auth.token', suggestedName: 'nexus' });
    expect(posted.at(-1)).toEqual({
      type: 'secretStored',
      field: 'auth.token',
      name: 'nexus-token',
    });
    // Known from now on, although no saved source references it yet.
    expect(posted[0]).toMatchObject({ type: 'state', state: { storedSecrets: ['nexus-token'] } });
  });

  it('tests the draft as given', async () => {
    const { host, posted } = setup({});
    await host.handle({ type: 'test', name: 'draft', source: FILE });
    expect(posted).toEqual([{ type: 'testResult', name: 'draft', text: 'tested draft' }]);
  });
});
