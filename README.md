# Leuchtturm Updater

Keeps VS Code extensions that are **not** on the Marketplace up to date. Leuchtturm checks
the sources you configure, tells you when a newer version is available and installs it when you
click _Update_. It never installs anything on its own.

It uses only public VS Code APIs and does not touch VS Code's marketplace configuration.

> Status: milestone M5. All four source types (`file`, `http`, `npm`, `script`), the sidebar,
> the status bar and multi-window scheduling work. Next: polish and v1.0 (VSIX verification,
> proxy support). See [`docs/SPEC.md`](docs/SPEC.md).

## Quick start (file share)

1. Put your `.vsix` files in a folder or on a share, named as `vsce package` names them:
   `corp.linter-1.4.1.vsix`.
2. Open your **user** settings (Command Palette → _Preferences: Open User Settings (JSON)_) and
   add:

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

| Command                               | What it does                                                           |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Leuchtturm: Check for Updates         | Checks all sources now.                                                |
| Leuchtturm: Update Extension…         | Pick from the available updates and install them.                      |
| Leuchtturm: Install Specific Version… | Install any offered version, including downgrades (with confirmation). |
| Leuchtturm: Reset Skipped Versions    | Forget versions skipped from a notification.                           |
| Leuchtturm: Show Log                  | Opens the "Leuchtturm Updater" output channel.                         |

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
internal servers are usually reachable. With Remote-SSH, WSL or Dev Containers, checks and
downloads still happen locally. The install goes through VS Code's own install command, which
decides where an extension ends up based on that extension's `extensionKind`. Remote setups
have not been tested systematically yet; please report problems.

## Development

```sh
npm install
npm run build             # bundle into dist/extension.js
npm test                  # unit tests (vitest)
npm run test:integration  # end-to-end in a downloaded VS Code
npm run lint              # eslint + prettier + tsc
npm run sandbox           # open a demo VS Code window (isolated profile, demo share)
npx vsce package          # build the .vsix
```

`npm run sandbox` rebuilds `.sandbox/` from scratch, with a fake share holding demo extensions
at several versions and an old version pre-installed. It then opens a separate VS Code window
running the development build. `TRY-ME.md` in that window lists what to try. The same scenario
drives the integration tests (`src/test/scenario.ts`).

## License

MIT
