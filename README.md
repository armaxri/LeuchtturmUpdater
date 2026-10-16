# Leuchtturm Updater

Keeps VS Code extensions that are **not** on the Marketplace up to date. Leuchtturm checks
the sources you configure, tells you when a newer version is available and installs it when you
click _Update_. It never installs anything on its own.

It uses only public VS Code APIs and does not touch VS Code's marketplace configuration.

![The Leuchtturm view: updates, extensions available to install, and a problem](docs/images/sidebar.png)

## Quick start (file share)

1. Put your `.vsix` files in a folder or on a share, named as `vsce package` names them:
   `corp.linter-1.4.1.vsix`.
2. Open the Leuchtturm view and click **+** (_Add Source…_). Pick _File share or folder_,
   enter the folder and save. The form checks every field as you type, and **Test** shows what
   the source finds before you rely on it.

   ![The source editor](docs/images/source-editor.png)

   The form writes to your user settings. You can also edit them directly
   (_Preferences: Open User Settings (JSON)_):

   ```jsonc
   "leuchtturm.sources": {
     "share": { "type": "file", "path": "\\\\fileserver\\vscode-extensions" }
   }
   ```

3. Run _Leuchtturm: Check for Updates_. Every installed extension that the share offers is
   now tracked. When a newer version shows up, Leuchtturm notifies you; _Show Updates_ lets you
   pick what to install.

Sources are read from user settings only. A `leuchtturm.sources` entry in a workspace's
`.vscode/settings.json` is ignored, so a cloned repository cannot add download locations.

## Commands

| Command                                  | What it does                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Leuchtturm: Check for Updates            | Checks all sources now.                                                |
| Leuchtturm: Add Source… / Manage Sources | Opens the source editor: a form per source, with validation and Test.  |
| Leuchtturm: Update Extension…            | Pick from the available updates and install them.                      |
| Leuchtturm: Install Specific Version…    | Install any offered version, including downgrades (with confirmation). |
| Leuchtturm: Reset Skipped Versions       | Forget versions skipped from a notification.                           |
| Leuchtturm: Show Log                     | Opens the "Leuchtturm Updater" output channel.                         |

## Settings

| Setting                          | Default |                                                                                                                                    |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `leuchtturm.enabled`             | `true`  | Master switch.                                                                                                                     |
| `leuchtturm.checkInterval`       | `60`    | Minutes between checks; `0` disables periodic checks (minimum 5).                                                                  |
| `leuchtturm.checkOnStartup`      | `true`  | Check about 10 s after startup.                                                                                                    |
| `leuchtturm.notify`              | `true`  | Notify about new updates. There is intentionally no auto-install.                                                                  |
| `leuchtturm.includePrerelease`   | `false` | Consider semver prereleases.                                                                                                       |
| `leuchtturm.sources`             | `{}`    | Named sources (user settings only).                                                                                                |
| `leuchtturm.extensions`          | `[]`    | What to track: `"id"`, `"source:id"` or `{ "id", "source", "pin", "enabled" }`. Empty = every installed extension a source offers. |
| `leuchtturm.trackAllFromSources` | `false` | Also list extensions that are offered but not installed.                                                                           |
| `leuchtturm.http.timeout`        | `30`    | Default timeout in seconds (also used for listing `file` sources).                                                                 |

## Source types

- [`file`](docs/sources/file.md): folder or network share with `.vsix` files.
- [`http`](docs/sources/http.md): Jenkins, web server listings, Artifactory, GitLab/Gitea
  packages, or any page that lists versions; regex or JSONPath matching, credentials, custom CAs.
- [`npm`](docs/sources/npm.md): any npm registry (Nexus, Artifactory, Verdaccio, …) with
  packages that wrap a `.vsix`; `.npmrc` credentials, integrity checks, publishing guide.
- [`script`](docs/sources/script.md): your own program (Python examples included) speaking a
  small JSON protocol; off unless enabled in user settings, approved once per program.

All settings, variables and secrets: [`docs/configuration.md`](docs/configuration.md).
Safeguards and the relation to the VS Code / Marketplace terms: [`docs/security.md`](docs/security.md).

## Remote development

Leuchtturm runs on the **local** machine (`extensionKind: ["ui"]`), where file shares and
internal servers are usually reachable. In Dev Containers, Remote-SSH and WSL windows:

- Your local user settings apply: the same sources, credentials and script approvals as in
  local windows. Nothing needs to be configured inside the container.
- Checks and downloads run locally. Installs go through VS Code's own install command, which
  puts each extension where it runs: most extensions on the remote side, UI extensions locally.
- VS Code only tells Leuchtturm about the extensions installed **locally**. For the ones on the
  remote side, Leuchtturm needs a small helper there. The sidebar shows _Extensions installed in
  the dev container are not visible yet_; click it once to install the helper (it ships with
  Leuchtturm; **Leuchtturm: Install Helper in Remote** does the same). A rebuilt container
  needs it again. Without the helper, remote-side extensions show up as _Not installed_.

This is tested automatically in a real Dev Containers window (`npm run test:remote`, needs
Docker). Remote-SSH and WSL use the same mechanism but are not tested automatically.

## Development

```sh
npm install
npm run build             # bundle into dist/extension.js
npm test                  # unit tests (vitest)
npm run test:integration  # end-to-end in a downloaded VS Code
npm run test:remote       # the same demo in a Dev Containers window (needs Docker)
npm run test:ui           # clicks through the source editor with Playwright
npm run lint              # eslint + prettier + tsc
npm run sandbox           # open a demo VS Code window (isolated profile, demo share)
npm run sandbox -- --dev-container  # the same, inside a dev container (needs Docker)
npm run screenshots       # re-render docs/images/*.png from the demo scenario
npx vsce package          # build the .vsix
```

`npm run sandbox` rebuilds `.sandbox/` from scratch, with a fake share holding demo extensions
at several versions and an old version pre-installed. It then opens a separate VS Code window
running the development build. `TRY-ME.md` in that window lists what to try. The same scenario
drives the integration tests (`src/test/scenario.ts`).

## License

MIT
