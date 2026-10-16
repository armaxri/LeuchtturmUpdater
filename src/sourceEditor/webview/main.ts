/**
 * The source editor page (runs inside the webview, a sandboxed browser frame; bundled to
 * dist/sourceEditor.js). It renders the form from formSpec.ts and talks to the extension only
 * through messages (protocol.ts): the extension validates, tests and saves.
 *
 * Plain DOM code, no framework. Inputs update the draft without re-rendering, so typing never
 * loses focus; the form is rebuilt only when switching sources, types or credential modes.
 */

import type { SourceType } from '../../sources/types';
import {
  sectionsFor,
  knownPaths,
  TYPE_LABELS,
  SOURCE_NAME,
  type AuthMode,
  type FieldSpec,
  type SectionSpec,
} from '../formSpec';
import type { EditorFocus, EditorState, FromWebview, ToWebview, Validation } from '../protocol';
import {
  authMode,
  fromInput,
  getPath,
  sameSource,
  setAuthMode,
  setPath,
  toText,
  type RawSource,
} from '../values';

// Provided by VS Code inside webviews; it can be called only once.
declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (message: FromWebview): void => vscode.postMessage(message);

const TYPES: readonly SourceType[] = ['file', 'http', 'npm', 'script'];
const TYPE_HELP: Record<SourceType, string> = {
  file: 'A folder or network share with .vsix files.',
  http: 'Any web page or API that lists versions: Jenkins, Artifactory, GitLab, a directory listing.',
  npm: 'Extensions published as npm packages to your company registry.',
  script: 'A program you write that answers in a small JSON protocol.',
};
const AUTH_LABELS: Record<AuthMode, string> = {
  none: 'None',
  basic: 'User and password',
  bearer: 'Bearer token',
  token: 'Token',
};

type View =
  | { mode: 'list' }
  | { mode: 'choose' }
  | { mode: 'edit'; originalName?: string; name: string; draft: RawSource };

let state: EditorState = { sources: {}, storedSecrets: [], scriptEnabled: false };
let view: View = { mode: 'list' };
let validation: Validation | undefined;
let requestId = 0;
let notice: { kind: 'error' | 'info'; text: string } | undefined;
let testOutput: { name: string; text?: string } | undefined;
/** Navigation that waits for "discard unsaved changes?". */
let pendingNavigation: (() => void) | undefined;

// --- DOM helpers ------------------------------------------------------------------------

type Child = Node | string | false | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === true) {
      node.setAttribute(key, '');
    } else if (typeof value === 'string') {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child !== false && child !== undefined) {
      node.append(child);
    }
  }
  return node;
}

function button(label: string, onClick: () => void, attrs: Record<string, string | boolean> = {}) {
  const b = el('button', { type: 'button', ...attrs }, label);
  b.addEventListener('click', onClick);
  return b;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** Replaces `parent`'s content, skipping `false`/`undefined` (optional parts). */
function fill(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren(
    ...children.filter((c): c is Node | string => c !== false && c !== undefined),
  );
}

// --- State helpers ----------------------------------------------------------------------

function isDirty(): boolean {
  if (view.mode !== 'edit') {
    return false;
  }
  if (view.originalName === undefined) {
    return true;
  }
  return (
    view.name !== view.originalName || !sameSource(view.draft, state.sources[view.originalName])
  );
}

/** Runs `go` now, or after the user agreed to drop unsaved changes. */
function navigate(go: () => void): void {
  if (isDirty()) {
    pendingNavigation = go;
    renderStatus();
    return;
  }
  go();
}

function openSource(name: string): void {
  const source = state.sources[name];
  if (!source) {
    view = { mode: 'list' };
  } else {
    view = { mode: 'edit', originalName: name, name, draft: structuredClone(source) };
  }
  testOutput = undefined;
  notice = undefined;
  render();
  validate();
}

function newSource(type: SourceType): void {
  let name: string = type === 'file' ? 'share' : type;
  for (let i = 2; name in state.sources; i++) {
    name = `${type}-${i}`;
  }
  view = { mode: 'edit', name, draft: { type } };
  testOutput = undefined;
  notice = undefined;
  render();
  validate();
}

let validateTimer: ReturnType<typeof setTimeout> | undefined;
function validate(): void {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(() => {
    if (view.mode === 'edit') {
      post({
        type: 'validate',
        requestId: ++requestId,
        name: view.name,
        originalName: view.originalName,
        source: view.draft,
      });
    }
  }, 200);
}

function updateDraft(change: (draft: RawSource) => RawSource): void {
  if (view.mode === 'edit') {
    view.draft = change(view.draft);
    notice = undefined;
    renderStatus();
    renderList();
    validate();
  }
}

// --- Rendering --------------------------------------------------------------------------

function render(): void {
  const app = $('app');
  fill(
    app,
    el(
      'div',
      { class: 'layout' },
      el('nav', { id: 'list', 'aria-label': 'Sources' }),
      el('main', { id: 'main' }),
    ),
  );
  renderList();
  renderMain();
}

function renderList(): void {
  const list = document.getElementById('list');
  if (!list) {
    return;
  }
  const items = Object.entries(state.sources).map(([name, source]) => {
    const active = view.mode === 'edit' && view.originalName === name;
    const disabled = source.enabled === false;
    const item = el(
      'li',
      {},
      button(name, () => navigate(() => openSource(name)), {
        class: `source${active ? ' active' : ''}`,
        'data-source': name,
        'aria-current': active ? 'true' : false,
      }),
    );
    const b = item.firstElementChild!;
    b.append(
      el('span', { class: 'badge' }, String(source.type ?? '?')),
      disabled ? el('span', { class: 'badge muted' }, 'off') : '',
      active && isDirty() ? el('span', { class: 'dot', title: 'Unsaved changes' }, '●') : '',
    );
    return item;
  });
  if (view.mode === 'edit' && view.originalName === undefined) {
    items.push(
      el(
        'li',
        {},
        el(
          'span',
          { class: 'source active new' },
          view.name || 'new source',
          el('span', { class: 'badge' }, String(view.draft.type)),
          el('span', { class: 'dot', title: 'Not saved yet' }, '●'),
        ),
      ),
    );
  }
  fill(
    list,
    el('h2', {}, 'Sources'),
    items.length > 0 ? el('ul', {}, ...items) : el('p', { class: 'muted' }, 'None yet.'),
    button('+ Add Source', () => navigate(() => ((view = { mode: 'choose' }), render())), {
      class: 'primary',
      id: 'add-source',
    }),
    el('hr'),
    button('Open settings.json', () => post({ type: 'openJson' }), { class: 'link' }),
  );
}

function renderMain(): void {
  const main = $('main');
  if (view.mode === 'list') {
    fill(
      main,
      el('h1', {}, 'Update sources'),
      el(
        'p',
        {},
        'Sources tell Leuchtturm where your company publishes VS Code extensions. They are ' +
          'stored in your user settings ("leuchtturm.sources"); workspace settings can never add one.',
      ),
      Object.keys(state.sources).length > 0
        ? el('p', {}, 'Select a source on the left to edit it, or add a new one.')
        : el('p', {}, 'There are no sources yet.'),
      button('Add Source', () => ((view = { mode: 'choose' }), render()), { class: 'primary' }),
    );
    return;
  }
  if (view.mode === 'choose') {
    fill(
      main,
      el('h1', {}, 'Add a source'),
      el('p', {}, 'Where are your extensions published?'),
      el(
        'div',
        { class: 'cards' },
        ...TYPES.map((type) => {
          const card = button('', () => newSource(type), { class: 'card', 'data-type': type });
          card.append(el('strong', {}, TYPE_LABELS[type]), el('span', {}, TYPE_HELP[type]));
          return card;
        }),
      ),
      button('Cancel', () => ((view = { mode: 'list' }), render())),
    );
    return;
  }

  const type = view.draft.type as SourceType;
  const known = new Set(knownPaths(type).map((p) => p.split('.')[0]));
  const unknown = Object.keys(view.draft).filter((k) => !known.has(k));
  const nameInput = el('input', {
    id: 'source-name',
    type: 'text',
    value: view.name,
    spellcheck: 'false',
    'aria-describedby': 'name-help',
  });
  nameInput.addEventListener('input', () => {
    if (view.mode === 'edit') {
      view.name = nameInput.value.trim();
      updateDraft((d) => d);
    }
  });

  fill(
    main,
    el(
      'div',
      { class: 'title' },
      el('h1', {}, view.originalName ?? 'New source'),
      el('span', { class: 'badge' }, TYPE_LABELS[type] ?? type),
      button('Documentation', () => post({ type: 'openDocs', sourceType: type }), {
        class: 'link',
      }),
    ),
    type === 'script' && !state.scriptEnabled
      ? el(
          'div',
          { class: 'banner warning' },
          'Script sources are turned off in your user settings. ',
          button('Open the setting', () => post({ type: 'openScriptSetting' }), { class: 'link' }),
        )
      : undefined,
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'source-name' }, 'Name'),
      nameInput,
      el(
        'small',
        { id: 'name-help' },
        'Shown in the sidebar and in messages. Letters, digits, "-", "_" and ".".',
      ),
    ),
    ...sectionsFor(type).map(renderSection),
    unknown.length > 0
      ? el(
          'p',
          { class: 'muted' },
          `Also set in settings.json and kept as is: ${unknown.join(', ')}.`,
        )
      : undefined,
    el('div', { id: 'status' }),
    el('div', { id: 'test-output' }),
  );
  renderStatus();
  renderTest();
}

function renderSection(section: SectionSpec): HTMLElement {
  if (view.mode !== 'edit') {
    return el('div');
  }
  const draft = view.draft;
  const basic = section.fields.filter((f) => !f.advanced);
  const advanced = section.fields.filter((f) => f.advanced);
  // "More options" starts open when one of its fields is already set.
  const advancedUsed = advanced.some((f) => getPath(draft, f.path) !== undefined);
  return el(
    'fieldset',
    {},
    el('legend', {}, section.title),
    section.help ? el('p', { class: 'help' }, section.help) : undefined,
    section.auth ? renderAuth(section.auth) : undefined,
    ...basic.map((f) => renderField(f)),
    advanced.length > 0
      ? el(
          'details',
          { open: advancedUsed },
          el('summary', {}, 'More options'),
          ...advanced.map((f) => renderField(f)),
        )
      : undefined,
  );
}

function renderAuth(modes: readonly AuthMode[]): HTMLElement {
  if (view.mode !== 'edit') {
    return el('div');
  }
  const current = authMode(view.draft);
  const radios = modes.map((mode) => {
    const input = el('input', {
      type: 'radio',
      name: 'auth-mode',
      value: mode,
      id: `auth-${mode}`,
      checked: mode === current,
    });
    input.addEventListener('change', () => {
      updateDraft((d) => setAuthMode(d, mode));
      renderMain();
    });
    return el('label', { class: 'radio', for: `auth-${mode}` }, input, AUTH_LABELS[mode]);
  });
  const fields: FieldSpec[] =
    current === 'basic'
      ? [
          { path: 'auth.basic.user', label: 'User', kind: 'text' },
          { path: 'auth.basic.password', label: 'Password', kind: 'secret' },
        ]
      : current === 'none'
        ? []
        : [{ path: `auth.${current}`, label: AUTH_LABELS[current], kind: 'secret' }];
  return el(
    'div',
    { class: 'auth' },
    el('div', { class: 'radios', role: 'radiogroup', 'aria-label': 'Credentials' }, ...radios),
    ...fields.map((f) => renderField(f, true)),
  );
}

const fieldId = (path: string) => `field-${path.replace(/\./g, '-')}`;

function renderField(field: FieldSpec, keepEmpty = false): HTMLElement {
  if (view.mode !== 'edit') {
    return el('div');
  }
  const id = fieldId(field.path);
  const value = getPath(view.draft, field.path);
  const store = (input: string | boolean): void => {
    try {
      // Credential fields keep "" so that the chosen credential mode stays visible.
      const stored = keepEmpty && input === '' ? '' : fromInput(field, input);
      updateDraft((d) => setPath(d, field.path, stored));
      error.textContent = '';
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  const error = el('small', { class: 'field-error', 'aria-live': 'polite' });
  const help = field.help ? el('small', { id: `${id}-help` }, field.help) : undefined;
  const label = el(
    'label',
    { for: id },
    field.label,
    field.required ? el('span', { class: 'required', title: 'Required' }, ' *') : '',
  );

  if (field.kind === 'boolean') {
    const input = el('input', {
      type: 'checkbox',
      id,
      checked: typeof value === 'boolean' ? value : (field.defaultValue ?? false),
    });
    input.addEventListener('change', () => store(input.checked));
    return el('div', { class: 'field checkbox' }, input, label, help, error);
  }

  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (field.kind === 'select') {
    const select = el(
      'select',
      { id },
      ...(field.options ?? []).map((o) =>
        el('option', { value: o, selected: (value ?? field.options?.[0]) === o }, o),
      ),
    );
    select.addEventListener('change', () => store(select.value));
    input = select;
  } else if (field.kind === 'list' || field.kind === 'map') {
    const text = toText(field, value);
    const area = el('textarea', {
      id,
      rows: String(Math.max(2, text.split('\n').length + 1)),
      placeholder: field.placeholder,
      spellcheck: 'false',
    });
    area.value = text;
    area.addEventListener('input', () => store(area.value));
    input = area;
  } else {
    const text = el('input', {
      id,
      type: field.kind === 'number' ? 'number' : 'text',
      placeholder: field.placeholder,
      spellcheck: 'false',
    });
    text.value = toText(field, value);
    text.addEventListener('input', () => store(text.value));
    input = text;
  }
  if (help) {
    input.setAttribute('aria-describedby', `${id}-help`);
  }

  const extras =
    field.kind === 'secret' ? renderSecretPicker(field, input as HTMLInputElement) : undefined;
  return el(
    'div',
    { class: 'field' },
    label,
    el('div', { class: 'row' }, input, extras),
    help,
    error,
  );
}

/** A credential field: pick a stored credential or store a new one. */
function renderSecretPicker(field: FieldSpec, input: HTMLInputElement): HTMLElement {
  const picker = el(
    'select',
    { 'aria-label': `Stored credential for ${field.label}` },
    el('option', { value: '' }, 'Stored credential…'),
    ...state.storedSecrets.map((s) => el('option', { value: s }, s)),
  );
  picker.addEventListener('change', () => {
    if (picker.value) {
      input.value = `\${secret:${picker.value}}`;
      input.dispatchEvent(new Event('input'));
      picker.value = '';
    }
  });
  const store = button(
    'Store new…',
    () =>
      post({
        type: 'storeSecret',
        field: field.path,
        suggestedName: view.mode === 'edit' ? view.name : 'credential',
      }),
    { class: 'secondary' },
  );
  return el('span', { class: 'secret-tools' }, state.storedSecrets.length ? picker : '', store);
}

function renderStatus(): void {
  const status = document.getElementById('status');
  if (!status || view.mode !== 'edit') {
    return;
  }
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  const dirty = isDirty();
  const saved = view.originalName !== undefined;
  const nameOk = SOURCE_NAME.test(view.name);
  fill(
    status,
    pendingNavigation
      ? el(
          'div',
          { class: 'banner warning' },
          'This source has unsaved changes. ',
          button('Discard changes', () => {
            const go = pendingNavigation;
            pendingNavigation = undefined;
            go?.();
          }),
          button('Keep editing', () => {
            pendingNavigation = undefined;
            renderStatus();
          }),
        )
      : undefined,
    notice ? el('div', { class: `banner ${notice.kind}`, role: 'status' }, notice.text) : undefined,
    errors.length > 0
      ? el(
          'ul',
          { class: 'messages errors', 'aria-live': 'polite' },
          ...errors.map((e) => el('li', {}, e)),
        )
      : undefined,
    warnings.length > 0
      ? el('ul', { class: 'messages warnings' }, ...warnings.map((w) => el('li', {}, w)))
      : undefined,
    el(
      'div',
      { class: 'buttons' },
      button('Save', save, {
        class: 'primary',
        id: 'save',
        disabled: !dirty || errors.length > 0 || !nameOk,
      }),
      button('Test', test, { id: 'test', disabled: errors.length > 0 }),
      saved && dirty
        ? button('Revert', () => openSource(view.mode === 'edit' ? view.originalName! : ''))
        : undefined,
      saved
        ? button(
            'Delete',
            () => post({ type: 'delete', name: view.mode === 'edit' ? view.originalName! : '' }),
            {
              class: 'danger',
            },
          )
        : button('Cancel', () => {
            view = { mode: 'list' };
            render();
          }),
    ),
  );
}

function renderTest(): void {
  const box = document.getElementById('test-output');
  if (!box) {
    return;
  }
  if (!testOutput || view.mode !== 'edit' || testOutput.name !== view.name) {
    fill(box);
    return;
  }
  fill(
    box,
    el('h2', {}, 'Test result'),
    testOutput.text === undefined
      ? el('p', { class: 'muted' }, 'Running…')
      : el('pre', { id: 'test-text' }, testOutput.text),
  );
}

function save(): void {
  if (view.mode === 'edit') {
    post({ type: 'save', name: view.name, originalName: view.originalName, source: view.draft });
  }
}

function test(): void {
  if (view.mode === 'edit') {
    testOutput = { name: view.name };
    renderTest();
    post({ type: 'test', name: view.name, source: view.draft });
  }
}

// --- Messages from the extension --------------------------------------------------------

function applyFocus(focus: EditorFocus | undefined): void {
  if (focus?.kind === 'source') {
    const justSaved =
      view.mode === 'edit' &&
      view.name === focus.name &&
      sameSource(view.draft, state.sources[focus.name]);
    if (justSaved) {
      // The draft is now what the settings hold: nothing would be lost.
      openSource(focus.name);
    } else {
      navigate(() => openSource(focus.name));
    }
  } else if (focus?.kind === 'new') {
    navigate(() => ((view = { mode: 'choose' }), render()));
  } else if (focus?.kind === 'list' && !isDirty()) {
    view = { mode: 'list' };
    render();
  }
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state': {
      state = message.state;
      if (message.focus) {
        applyFocus(message.focus);
        return;
      }
      // Settings changed elsewhere: follow them unless the user is in the middle of an edit.
      if (view.mode === 'edit' && view.originalName !== undefined && !isDirty()) {
        if (view.originalName in state.sources) {
          view.draft = structuredClone(state.sources[view.originalName]!);
        } else {
          view = { mode: 'list' };
        }
      }
      render();
      validate();
      return;
    }
    case 'validation':
      if (message.requestId === requestId) {
        validation = message.result;
        renderStatus();
      }
      return;
    case 'testResult':
      testOutput = { name: message.name, text: message.text };
      renderTest();
      return;
    case 'saved':
      notice = { kind: 'info', text: `Saved "${message.name}" to your user settings.` };
      renderStatus();
      return;
    case 'deleted':
      notice = undefined;
      return;
    case 'secretStored': {
      const input = document.getElementById(fieldId(message.field));
      if (input instanceof HTMLInputElement) {
        input.value = `\${secret:${message.name}}`;
        input.dispatchEvent(new Event('input'));
      }
      return;
    }
    case 'error':
      notice = { kind: 'error', text: message.message };
      renderStatus();
      return;
  }
});

render();
post({ type: 'ready' });
