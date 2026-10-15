# Changelog

## 0.5.0 (unreleased)

Milestone M5: script sources.

- `script` source: runs your program with templated arguments (no shell) and reads one JSON
  document per action (`list`, `download` by path or URL, optional `notes`, error responses).
  Context in `LEUCHTTURM_*` environment variables, `ref` values passed back on download.
- Off unless `leuchtturm.script.enabled` is true in the user settings (re-checked before every
  run); each program is approved once per command and script path (_Allow Script Source…_).
- Timeouts and cancellation kill the whole process tree.
- Responses are validated against the shipped `schemas/script-protocol.schema.json` with
  precise error messages.
- Problems can carry a fix: clicking one opens the right setting or the approval dialog.
- Python examples (standard library, 3.8+) with a helper module, all exercised by tests.
- Docs: `docs/sources/script.md` (protocol reference), `docs/security.md`,
  `examples/script/`, `examples/settings/script.jsonc`.

## 0.4.0 (unreleased)

Milestone M4: npm registries.

- `npm` source: reads packuments from any registry, lists a scope via the search API or
  explicit `packages`, maps versions to extension IDs (`vscodeExtension`, `publisher` + name,
  or the `.vsix` inside), hides deprecated versions.
- Credentials from `auth` or `.npmrc` (`_authToken`, `_auth`, `username`/`_password`, most
  specific path wins), only sent to the registry's own host.
- Downloads verify `dist.integrity`/`dist.shasum` and extract the single root `.vsix`
  (built-in tar reader, no new dependency).
- Docs: `docs/sources/npm.md` with a publishing guide and CI example,
  `examples/npm/package.json`, `examples/npm/publish.sh`, `examples/settings/npm.jsonc`.

## 0.3.0 (unreleased)

Milestone M3: HTTP sources.

- `http` source: index request → regex or JSONPath matcher (with parent fields, `where`
  filters) → download request, for Jenkins, directory listings, Artifactory, GitLab and Gitea.
- Basic and bearer auth, `${secret:NAME}` credentials via the new _Store Credential…_ command,
  `ca` for internal certificate authorities, `strictSSL: false` with a visible warning.
- Release notes from a URL are fetched with the source's credentials.
- _Test Source_ shows the HTTP status, the start of the body, every match with its groups and
  the resolved download URLs.
- Extensions without a display name from their source use the installed extension's name.
- Docs: `docs/sources/http.md`, `docs/configuration.md`, `examples/settings/http.jsonc`.

## 0.2.0 (unreleased)

Milestone M2: visibility.

- Leuchtturm view in the activity bar: updates, up to date, not installed and problems, with
  inline _Update_, _Release notes_, _Skip_ and per-version _Install This Version_.
- Activity bar badge and status bar item (`leuchtturm.statusBar`), with a spinner while
  checking.
- _Update All_, _Test Source…_ and _Open Settings_ commands.
- Notifications now offer _Show in Leuchtturm_, which selects the update in the tree.
- Only one VS Code window checks; the others reuse its cached results. Installs of the same
  extension are locked across windows. Failing sources are retried with exponential back-off.
- Editing `leuchtturm.sources` re-checks added or changed sources right away.

## 0.1.0 (unreleased)

First milestone (M1).

- `file` source: folders and network shares with `.vsix` files, VSIX Manager layouts,
  `.sha256` and `.md` sidecars.
- Update checks on startup and every `leuchtturm.checkInterval` minutes, plus
  _Leuchtturm: Check for Updates_.
- Notifications for newly found updates. Nothing is ever installed automatically.
- _Update Extension…_ and _Install Specific Version…_ (with downgrade confirmation),
  installing through VS Code's `installExtension` command, followed by a reload prompt.
- `leuchtturm.extensions` tracking list with per-source restriction and semver `pin`.
- Output channel "Leuchtturm Updater" with secrets redacted.
