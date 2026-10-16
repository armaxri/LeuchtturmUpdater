/**
 * The extension side of the source editor: answers the webview's messages. Everything that
 * touches VS Code comes in through `EditorDeps`, so this is unit tested without VS Code
 * (panel.ts wires it to the real APIs).
 */

import type { SourceType } from '../sources/types';
import type { Discovery, EditorFocus, EditorState, FromWebview, ToWebview } from './protocol';
import { validateSource } from './validate';
import type { RawSource } from './values';

export interface EditorDeps {
  /** User-level `leuchtturm.sources` (never workspace values). */
  readSources(): Record<string, unknown>;
  /** Writes `leuchtturm.sources` to the user settings. */
  writeSources(sources: Record<string, unknown>): Promise<void>;
  confirm(message: string, action: string): Promise<boolean>;
  test(name: string, source: RawSource): Promise<string>;
  /** "Paste a link": recognises the input and proposes a source (discover.ts). */
  discover(input: string): Promise<Discovery>;
  /** Shows a folder picker; undefined if cancelled. */
  pickFolder(): Promise<string | undefined>;
  scriptEnabled(): boolean;
  open(what: 'scriptSetting' | 'json' | { docs: SourceType }): void;
  post(message: ToWebview): void;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class SourceEditorHost {
  constructor(private readonly deps: EditorDeps) {}

  state(): EditorState {
    const sources = Object.fromEntries(
      Object.entries(this.deps.readSources()).filter((e): e is [string, RawSource] =>
        isObject(e[1]),
      ),
    );
    return { sources, scriptEnabled: this.deps.scriptEnabled() };
  }

  /** Sends the current settings, e.g. after they changed in settings.json. */
  refresh(focus?: EditorFocus): void {
    this.deps.post({ type: 'state', state: this.state(), focus });
  }

  async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        return this.refresh();
      case 'validate': {
        const state = this.state();
        const otherNames = Object.keys(state.sources).filter((n) => n !== message.originalName);
        this.deps.post({
          type: 'validation',
          requestId: message.requestId,
          result: validateSource(message.name, message.source, {
            otherNames,
            scriptEnabled: state.scriptEnabled,
          }),
        });
        return;
      }
      case 'test':
        this.deps.post({
          type: 'testResult',
          name: message.name,
          text: await this.deps.test(message.name, message.source),
        });
        return;
      case 'discover': {
        const result = await this.deps.discover(message.input);
        if (result.kind === 'found') {
          // Never suggest a name that is taken.
          result.name = this.freeName(result.name);
        }
        this.deps.post({ type: 'discovered', input: message.input, result });
        return;
      }
      case 'pickFolder': {
        const folder = await this.deps.pickFolder();
        if (folder) {
          this.deps.post({ type: 'folderPicked', path: folder });
        }
        return;
      }
      case 'save':
        return this.save(message.name, message.source, message.originalName);
      case 'delete':
        return this.delete(message.name);
      case 'openScriptSetting':
        return this.deps.open('scriptSetting');
      case 'openJson':
        return this.deps.open('json');
      case 'openDocs':
        return this.deps.open({ docs: message.sourceType });
    }
  }

  /** `name`, or `name-2`, `name-3`, … if it is taken. */
  private freeName(name: string): string {
    const taken = this.deps.readSources();
    let candidate = name;
    for (let i = 2; candidate in taken; i++) {
      candidate = `${name}-${i}`;
    }
    return candidate;
  }

  /**
   * Saves one source into the user settings. Re-reads the settings first, so edits made
   * elsewhere in the meantime are kept; a renamed source keeps its position.
   */
  private async save(name: string, source: RawSource, originalName?: string): Promise<void> {
    const current = this.deps.readSources();
    const otherNames = Object.keys(current).filter((n) => n !== originalName);
    const validation = validateSource(name, source, { otherNames, scriptEnabled: true });
    if (validation.errors.length > 0) {
      this.deps.post({ type: 'error', message: validation.errors.join(' ') });
      return;
    }
    // Entries, not object assignment: a source named "__proto__" must stay a plain key.
    const entries = Object.entries(current);
    const index = entries.findIndex(([n]) => n === (originalName ?? name));
    if (index >= 0) {
      entries[index] = [name, source];
    } else {
      entries.push([name, source]);
    }
    await this.deps.writeSources(Object.fromEntries(entries));
    this.refresh({ kind: 'source', name });
    this.deps.post({ type: 'saved', name });
  }

  private async delete(name: string): Promise<void> {
    const current = this.deps.readSources();
    if (!(name in current)) {
      return;
    }
    if (!(await this.deps.confirm(`Delete the source "${name}" from your settings?`, 'Delete'))) {
      return;
    }
    await this.deps.writeSources(
      Object.fromEntries(Object.entries(current).filter(([n]) => n !== name)),
    );
    this.deps.post({ type: 'deleted', name });
    this.refresh({ kind: 'list' });
  }
}
