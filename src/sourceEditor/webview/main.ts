/**
 * The source editor page (runs inside the webview, a sandboxed browser frame; bundled to
 * dist/sourceEditor.js). It talks to the extension only through messages (protocol.ts): the
 * extension looks links up, validates, tests and saves.
 *
 * Adding a source starts from what the user has: they paste a link (a Jenkins page, a web
 * page with .vsix links, a folder, an npm package name) and the extension proposes a working
 * configuration. The detailed form (rendered from formSpec.ts) is there to adjust it, and to
 * edit existing sources.
 *
 * Plain DOM code, no framework. Inputs update the draft without re-rendering, so typing never
 * loses focus; the form is rebuilt only when switching between sources or views.
 */

import type { SourceType } from '../../sources/types';
import {
  knownPaths,
  sectionsFor,
  SOURCE_NAME,
  TYPE_LABELS,
  type FieldSpec,
  type SectionSpec,
} from '../formSpec';
import type {
  Discovery,
  EditorFocus,
  EditorState,
  FromWebview,
  ToWebview,
  Validation,
} from '../protocol';
import { fromInput, getPath, sameSource, setPath, toText, type RawSource } from '../values';

// Provided by VS Code inside webviews; it can be called only once.
declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (message: FromWebview): void => vscode.postMessage(message);

const TYPES: readonly SourceType[] = ['file', 'http', 'npm', 'script'];
const TYPE_HELP: Record<SourceType, string> = {
  file: 'A folder or network share with .vsix files.',
  http: 'A web page or API that lists versions, with your own regex or JSONPath.',
  npm: 'Extensions published as npm packages; uses your npm configuration.',
  script: 'A program that lists and downloads extensions, e.g. from a server that needs a login.',
};

type View =
  | { mode: 'list' }
  /** "Paste a link": the main way to add a source. */
  | { mode: 'discover'; input: string; busy: boolean; result?: Discovery; name?: string }
  /** Set up manually: pick a type, then the detailed form. */
  | { mode: 'choose' }
  | { mode: 'edit'; originalName?: string; name: string; draft: RawSource };

let state: EditorState = { sources: {}, scriptEnabled: false };
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

function show(next: View): void {
  view = next;
  testOutput = undefined;
  notice = undefined;
  pendingNavigation = undefined;
  render();
  if (view.mode === 'edit') {
    validate();
  }
  // Put the cursor where the user types next.
  const focus =
    view.mode === 'discover' && !view.result
      ? document.getElementById('discover-input')
      : view.mode === 'discover'
        ? document.getElementById('discover-name')
        : undefined;
  focus?.focus();
}

function openSource(name: string): void {
  const source = state.sources[name];
  show(
    source
      ? { mode: 'edit', originalName: name, name, draft: structuredClone(source) }
      : { mode: 'list' },
  );
}

function freeName(base: string): string {
  let name = base;
  for (let i = 2; name in state.sources; i++) {
    name = `${base}-${i}`;
  }
  return name;
}

function newSource(type: SourceType): void {
  show({ mode: 'edit', name: freeName(type === 'file' ? 'share' : type), draft: { type } });
}

function startDiscover(input = ''): void {
  show({ mode: 'discover', input, busy: false });
}

function runDiscover(input: string): void {
  if (!input.trim()) {
    return;
  }
  view = { mode: 'discover', input, busy: true };
  render();
  post({ type: 'discover', input });
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
  fill(
    $('app'),
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
    const b = button(name, () => navigate(() => openSource(name)), {
      class: `source${active ? ' active' : ''}`,
      'data-source': name,
      'aria-current': active ? 'true' : false,
    });
    b.append(
      el('span', { class: 'badge' }, String(source.type ?? '?')),
      source.enabled === false ? el('span', { class: 'badge muted' }, 'off') : '',
      active && isDirty() ? el('span', { class: 'dot', title: 'Unsaved changes' }, '●') : '',
    );
    return el('li', {}, b);
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
    button('+ Add Source', () => navigate(() => startDiscover()), {
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
        'A source is where your team publishes VS Code extensions: a Jenkins job, a web page ' +
          'or folder with .vsix files, or an npm registry. Leuchtturm checks your sources and ' +
          'tells you when an update is available.',
      ),
      Object.keys(state.sources).length > 0
        ? el('p', {}, 'Select a source on the left to change it, or add a new one.')
        : el('p', {}, 'There are no sources yet.'),
      button('Add Source', () => startDiscover(), { class: 'primary' }),
    );
    return;
  }
  if (view.mode === 'discover') {
    renderDiscover(main, view);
    return;
  }
  if (view.mode === 'choose') {
    fill(
      main,
      el('h1', {}, 'Set up a source manually'),
      el('p', {}, 'For experts: pick a type and fill in every detail yourself.'),
      el(
        'div',
        { class: 'cards' },
        ...TYPES.map((type) => {
          const card = button('', () => newSource(type), { class: 'card', 'data-type': type });
          card.append(el('strong', {}, TYPE_LABELS[type]), el('span', {}, TYPE_HELP[type]));
          return card;
        }),
      ),
      button('Back', () => startDiscover()),
    );
    return;
  }
  renderEdit(main);
}

/** "Paste a link" and, once looked up, what was found. */
function renderDiscover(main: HTMLElement, v: Extract<View, { mode: 'discover' }>): void {
  const input = el('input', {
    id: 'discover-input',
    type: 'text',
    value: v.input,
    spellcheck: 'false',
    placeholder: 'https://jenkins.example.com/job/my-extension/   or   \\\\server\\share\\vsix',
    'aria-describedby': 'discover-help',
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      runDiscover(input.value);
    }
  });
  const form = el(
    'div',
    { class: 'discover' },
    el('label', { for: 'discover-input' }, 'Where do you download the extension?'),
    el(
      'div',
      { class: 'row' },
      input,
      button(v.busy ? 'Looking…' : 'Look Up', () => runDiscover(input.value), {
        class: 'primary',
        id: 'discover-run',
        disabled: v.busy,
      }),
      button('Choose Folder…', () => post({ type: 'pickFolder' }), { id: 'discover-folder' }),
    ),
    el(
      'small',
      { id: 'discover-help' },
      'Paste the link of a Jenkins job (or its "Last Successful Artifacts"), of a web page ' +
        'that lists .vsix files, or of one .vsix file. A folder or network share works too, ' +
        'and so does an npm package name like @corp/linter.',
    ),
  );
  fill(
    main,
    el('h1', {}, 'Add a source'),
    form,
    v.busy ? el('p', { class: 'muted', role: 'status' }, 'Looking it up…') : undefined,
    v.result ? renderDiscovery(v, v.result) : undefined,
    el(
      'p',
      { class: 'manual' },
      'Know exactly what you need? ',
      button('Set up manually', () => show({ mode: 'choose' }), { class: 'link' }),
    ),
  );
}

function renderDiscovery(v: Extract<View, { mode: 'discover' }>, result: Discovery): HTMLElement {
  if (result.kind === 'login') {
    return el(
      'div',
      { class: 'result banner warning', id: 'discover-result' },
      el('strong', {}, `${capitalize(result.what)} needs a login.`),
      el('p', {}, result.message),
      el(
        'div',
        { class: 'buttons' },
        button('About script sources', () => post({ type: 'openDocs', sourceType: 'script' }), {
          class: 'link',
        }),
        button('Set Up a Script Source', () => newSource('script')),
      ),
    );
  }
  if (result.kind === 'problem') {
    return el(
      'div',
      { class: 'result banner error', id: 'discover-result' },
      el('strong', {}, result.message),
      result.hints.length > 0
        ? el('ul', {}, ...result.hints.map((h) => el('li', {}, h)))
        : undefined,
    );
  }

  const name = v.name ?? result.name;
  const nameInput = el('input', {
    id: 'discover-name',
    type: 'text',
    value: name,
    spellcheck: 'false',
  });
  const nameError = el('small', { class: 'field-error', 'aria-live': 'polite' });
  const save = button('Save', () => saveDiscovered(), { class: 'primary', id: 'discover-save' });
  const checkName = (): void => {
    const n = nameInput.value.trim();
    const problem = !SOURCE_NAME.test(n)
      ? 'Use letters, digits, "-", "_" and "." only.'
      : n in state.sources
        ? `There is already a source named "${n}".`
        : '';
    nameError.textContent = problem;
    save.disabled = problem !== '';
  };
  nameInput.addEventListener('input', () => {
    v.name = nameInput.value.trim();
    checkName();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !save.disabled) {
      saveDiscovered();
    }
  });
  const saveDiscovered = (): void => {
    post({ type: 'save', name: nameInput.value.trim(), source: result.source });
  };
  queueMicrotask(checkName);

  const rows = result.extensions.map((e) =>
    el(
      'tr',
      {},
      el(
        'td',
        {},
        e.displayName ? el('strong', {}, e.displayName) : '',
        e.displayName ? el('br') : '',
        el('code', {}, e.id),
      ),
      el('td', {}, e.versions[0] ?? ''),
      el(
        'td',
        { class: 'muted' },
        e.versions.length > 1
          ? `${e.versions.length - 1} older: ${e.versions.slice(1, 6).join(', ')}${e.versions.length > 6 ? ', …' : ''}`
          : '',
      ),
    ),
  );
  return el(
    'div',
    { class: 'result', id: 'discover-result' },
    el(
      'p',
      { class: 'found-title' },
      el(
        'strong',
        {},
        `Found ${result.extensions.length} extension${result.extensions.length === 1 ? '' : 's'}`,
      ),
      ` in ${result.what}.`,
    ),
    el(
      'table',
      { class: 'found' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Extension'),
          el('th', {}, 'Newest'),
          el('th', {}, 'Also available'),
        ),
      ),
      el('tbody', {}, ...rows),
    ),
    result.notes.length > 0
      ? el('ul', { class: 'notes' }, ...result.notes.map((n) => el('li', {}, n)))
      : undefined,
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'discover-name' }, 'Name for this source'),
      nameInput,
      nameError,
    ),
    el(
      'div',
      { class: 'buttons' },
      save,
      button('Adjust Details…', () =>
        show({ mode: 'edit', name: nameInput.value.trim(), draft: structuredClone(result.source) }),
      ),
    ),
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function renderEdit(main: HTMLElement): void {
  if (view.mode !== 'edit') {
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

const fieldId = (path: string) => `field-${path.replace(/\./g, '-')}`;

function renderField(field: FieldSpec): HTMLElement {
  if (view.mode !== 'edit') {
    return el('div');
  }
  const id = fieldId(field.path);
  const value = getPath(view.draft, field.path);
  const error = el('small', { class: 'field-error', 'aria-live': 'polite' });
  const store = (input: string | boolean): void => {
    try {
      const stored = fromInput(field, input);
      updateDraft((d) => setPath(d, field.path, stored));
      error.textContent = '';
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  };
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
  return el('div', { class: 'field' }, label, input, help, error);
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
  const original = view.originalName;
  fill(
    status,
    pendingNavigation
      ? el(
          'div',
          { class: 'banner warning' },
          'This source has unsaved changes. ',
          button('Discard Changes', () => {
            const go = pendingNavigation;
            pendingNavigation = undefined;
            go?.();
          }),
          button('Keep Editing', () => {
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
      saved && dirty ? button('Revert', () => openSource(original!)) : undefined,
      saved
        ? button('Delete', () => post({ type: 'delete', name: original! }), { class: 'danger' })
        : button('Cancel', () => show({ mode: 'list' })),
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
    // After saving, the settings hold exactly what is shown: nothing would be lost.
    const justSaved =
      (view.mode === 'edit' &&
        view.name === focus.name &&
        sameSource(view.draft, state.sources[focus.name])) ||
      view.mode === 'discover';
    if (justSaved) {
      openSource(focus.name);
    } else {
      navigate(() => openSource(focus.name));
    }
  } else if (focus?.kind === 'new') {
    navigate(() => startDiscover());
  } else if (focus?.kind === 'list' && !isDirty()) {
    show({ mode: 'list' });
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
      if (view.mode === 'discover') {
        renderList(); // keep the typed link and the result
      } else {
        render();
        validate();
      }
      return;
    }
    case 'discovered':
      if (view.mode === 'discover' && view.input === message.input) {
        view = { mode: 'discover', input: message.input, busy: false, result: message.result };
        render();
        document.getElementById('discover-name')?.focus();
      }
      return;
    case 'folderPicked':
      runDiscover(message.path);
      return;
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
    case 'error':
      notice = { kind: 'error', text: message.message };
      if (view.mode === 'discover') {
        render();
        const result = document.getElementById('discover-result');
        result?.prepend(el('div', { class: 'banner error', role: 'status' }, message.message));
      } else {
        renderStatus();
      }
      return;
  }
});

render();
post({ type: 'ready' });
