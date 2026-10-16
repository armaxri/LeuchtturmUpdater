/**
 * The extension side of the source editor: answers the webview's messages. Everything that
 * touches VS Code comes in through `EditorDeps`, so this is unit tested without VS Code
 * (panel.ts wires it to the real APIs).
 */

import { referencedSecrets } from '../config';
import type { SourceType } from '../sources/types';
import type { EditorFocus, EditorState, FromWebview, ToWebview } from './protocol';
import { validateSource } from './validate';
import type { RawSource } from './values';

export interface EditorDeps {
  /** User-level `leuchtturm.sources` (never workspace values). */
  readSources(): Record<string, unknown>;
  /** Writes `leuchtturm.sources` to the user settings. */
  writeSources(sources: Record<string, unknown>): Promise<void>;
  isSecretStored(name: string): Promise<boolean>;
  /** Asks for a credential's value (password box) and stores it; false if cancelled. */
  storeSecret(name: string): Promise<boolean>;
  /** Asks for a new credential name; undefined if cancelled. */
  askSecretName(suggested: string): Promise<string | undefined>;
  confirm(message: string, action: string): Promise<boolean>;
  test(name: string, source: RawSource): Promise<string>;
  scriptEnabled(): boolean;
  open(what: 'scriptSetting' | 'json' | { docs: SourceType }): void;
  post(message: ToWebview): void;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class SourceEditorHost {
  /** Credentials stored from the editor that unsaved drafts may already use. */
  private readonly sessionSecrets = new Set<string>();

  constructor(private readonly deps: EditorDeps) {}

  async state(): Promise<EditorState> {
    const raw = this.deps.readSources();
    const sources = Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, RawSource] => isObject(e[1])),
    );
    const names = new Set([...referencedSecrets(sources), ...this.sessionSecrets]);
    const storedSecrets: string[] = [];
    for (const name of [...names].sort()) {
      if (await this.deps.isSecretStored(name)) {
        storedSecrets.push(name);
      }
    }
    return { sources, storedSecrets, scriptEnabled: this.deps.scriptEnabled() };
  }

  /** Sends the current settings, e.g. after they changed in settings.json. */
  async refresh(focus?: EditorFocus): Promise<void> {
    this.deps.post({ type: 'state', state: await this.state(), focus });
  }

  async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        return this.refresh();
      case 'validate': {
        const state = await this.state();
        const otherNames = Object.keys(state.sources).filter((n) => n !== message.originalName);
        this.deps.post({
          type: 'validation',
          requestId: message.requestId,
          result: validateSource(message.name, message.source, {
            otherNames,
            storedSecrets: state.storedSecrets,
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
      case 'save':
        return this.save(message.name, message.source, message.originalName);
      case 'delete':
        return this.delete(message.name);
      case 'storeSecret': {
        const name = await this.deps.askSecretName(message.suggestedName);
        if (name && (await this.deps.storeSecret(name))) {
          this.sessionSecrets.add(name);
          await this.refresh();
          this.deps.post({ type: 'secretStored', field: message.field, name });
        }
        return;
      }
      case 'openScriptSetting':
        return this.deps.open('scriptSetting');
      case 'openJson':
        return this.deps.open('json');
      case 'openDocs':
        return this.deps.open({ docs: message.sourceType });
    }
  }

  /**
   * Saves one source into the user settings. Re-reads the settings first, so edits made
   * elsewhere in the meantime are kept; a renamed source keeps its position.
   */
  private async save(name: string, source: RawSource, originalName?: string): Promise<void> {
    const current = this.deps.readSources();
    const otherNames = Object.keys(current).filter((n) => n !== originalName);
    const validation = validateSource(name, source, {
      otherNames,
      storedSecrets: [],
      scriptEnabled: true,
    });
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
    await this.refresh({ kind: 'source', name });
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
    await this.refresh({ kind: 'list' });
  }
}
