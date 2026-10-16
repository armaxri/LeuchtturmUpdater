/** Messages between the source editor webview and the extension (both directions are JSON). */

import type { SourceType } from '../sources/types';
import type { RawSource } from './values';

export interface Validation {
  /** The source cannot be used like this. */
  errors: string[];
  /** It works, but something deserves attention (e.g. scripts are turned off). */
  warnings: string[];
}

export interface EditorState {
  /** `leuchtturm.sources` from the user settings, in settings order. */
  sources: Record<string, RawSource>;
  scriptEnabled: boolean;
}

/** What the editor should show first. */
export type EditorFocus = { kind: 'source'; name: string } | { kind: 'new' } | { kind: 'list' };

export interface FoundExtension {
  id: string;
  displayName?: string;
  /** Newest first. */
  versions: string[];
}

/** The result of "paste a link" (discover.ts). */
export type Discovery =
  | {
      kind: 'found';
      /** What the input turned out to be, e.g. `Jenkins job "corp-linter"`. */
      what: string;
      /** Suggested source name. */
      name: string;
      /** The generated configuration. */
      source: RawSource;
      extensions: FoundExtension[];
      /** Short explanations shown with the result. */
      notes: string[];
    }
  /** The server wants a login, which Leuchtturm does not handle (use a script source). */
  | { kind: 'login'; what: string; message: string }
  | { kind: 'problem'; message: string; hints: string[] };

export type ToWebview =
  | { type: 'state'; state: EditorState; focus?: EditorFocus }
  | { type: 'validation'; requestId: number; result: Validation }
  | { type: 'testResult'; name: string; text: string }
  | { type: 'discovered'; input: string; result: Discovery }
  /** The user picked a folder with "Choose Folder…"; the page fills it in and looks it up. */
  | { type: 'folderPicked'; path: string }
  | { type: 'saved'; name: string }
  | { type: 'deleted'; name: string }
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
  | { type: 'discover'; input: string }
  | { type: 'pickFolder' }
  | { type: 'save'; name: string; originalName?: string; source: RawSource }
  | { type: 'delete'; name: string }
  | { type: 'openScriptSetting' }
  | { type: 'openJson' }
  | { type: 'openDocs'; sourceType: SourceType };
