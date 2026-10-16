/** Messages between the source editor webview and the extension (both directions are JSON). */

import type { SourceType } from '../sources/types';
import type { RawSource } from './values';

export interface Validation {
  /** The source cannot be used like this. */
  errors: string[];
  /** It works, but something deserves attention (missing credential, plain-text password). */
  warnings: string[];
}

export interface EditorState {
  /** `leuchtturm.sources` from the user settings, in settings order. */
  sources: Record<string, RawSource>;
  /** Credential names that are stored (of those Leuchtturm knows about). */
  storedSecrets: string[];
  scriptEnabled: boolean;
}

/** What the editor should show first. */
export type EditorFocus = { kind: 'source'; name: string } | { kind: 'new' } | { kind: 'list' };

export type ToWebview =
  | { type: 'state'; state: EditorState; focus?: EditorFocus }
  | { type: 'validation'; requestId: number; result: Validation }
  | { type: 'testResult'; name: string; text: string }
  | { type: 'saved'; name: string }
  | { type: 'deleted'; name: string }
  /** A credential was stored; the field that asked for it gets `${secret:NAME}`. */
  | { type: 'secretStored'; field: string; name: string }
  | { type: 'error'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | {
      type: 'validate';
      requestId: number;
      name: string;
      /** The name the source has in the settings, if it was saved before. */
      originalName?: string;
      source: RawSource;
    }
  | { type: 'test'; name: string; source: RawSource }
  | { type: 'save'; name: string; originalName?: string; source: RawSource }
  | { type: 'delete'; name: string }
  | { type: 'storeSecret'; field: string; suggestedName: string }
  | { type: 'openScriptSetting' }
  | { type: 'openJson' }
  | { type: 'openDocs'; sourceType: SourceType };
