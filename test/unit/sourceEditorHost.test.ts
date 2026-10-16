import { describe, expect, it } from 'vitest';

import { SourceEditorHost, type EditorDeps } from '../../src/sourceEditor/host';
import type { Discovery, ToWebview } from '../../src/sourceEditor/protocol';

function setup(
  initial: Record<string, unknown> = {},
  options: { confirm?: boolean; discovery?: Discovery; folder?: string } = {},
) {
  let sources: Record<string, unknown> = initial;
  const posted: ToWebview[] = [];
  const writes: Record<string, unknown>[] = [];
  const deps: EditorDeps = {
    readSources: () => sources,
    writeSources: (next) => {
      sources = next;
      writes.push(next);
      return Promise.resolve();
    },
    confirm: () => Promise.resolve(options.confirm ?? true),
    test: (name) => Promise.resolve(`tested ${name}`),
    discover: () =>
      Promise.resolve(options.discovery ?? { kind: 'problem', message: 'nothing', hints: [] }),
    pickFolder: () => Promise.resolve(options.folder),
    scriptEnabled: () => false,
    open: () => undefined,
    post: (m) => posted.push(m),
  };
  return { host: new SourceEditorHost(deps), posted, writes, sources: () => sources };
}

const FILE = { type: 'file', path: '/tmp' };

describe('SourceEditorHost', () => {
  it('sends the user-level sources, skipping malformed entries', async () => {
    const { host, posted } = setup({ a: FILE, junk: 'not an object' });
    await host.handle({ type: 'ready' });
    expect(posted).toEqual([
      { type: 'state', focus: undefined, state: { sources: { a: FILE }, scriptEnabled: false } },
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

  it('passes on what a pasted link turned out to be, with a name that is free', async () => {
    const discovery: Discovery = {
      kind: 'found',
      what: 'Jenkins job "ci"',
      name: 'ci',
      source: { type: 'http' },
      extensions: [{ id: 'corp.ci', versions: ['1.0.0'] }],
      notes: [],
    };
    const { host, posted } = setup({ ci: FILE, 'ci-2': FILE }, { discovery });
    await host.handle({ type: 'discover', input: 'https://jenkins/job/ci/' });
    expect(posted).toEqual([
      {
        type: 'discovered',
        input: 'https://jenkins/job/ci/',
        result: { ...discovery, name: 'ci-3' },
      },
    ]);
  });

  it('hands a picked folder to the page; nothing if the dialog was cancelled', async () => {
    const picked = setup({}, { folder: '/shares/vsix' });
    await picked.host.handle({ type: 'pickFolder' });
    expect(picked.posted).toEqual([{ type: 'folderPicked', path: '/shares/vsix' }]);
    const cancelled = setup({});
    await cancelled.host.handle({ type: 'pickFolder' });
    expect(cancelled.posted).toEqual([]);
  });

  it('tests the draft as given', async () => {
    const { host, posted } = setup({});
    await host.handle({ type: 'test', name: 'draft', source: FILE });
    expect(posted).toEqual([{ type: 'testResult', name: 'draft', text: 'tested draft' }]);
  });
});
