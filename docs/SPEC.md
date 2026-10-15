# Leuchtturm Updater — Specification

Leuchtturm Updater is a VS Code extension that keeps extensions which are **not** on the
Microsoft Marketplace up to date. It watches one or more configured *sources*, shows what is
installed versus what is available, notifies the user about updates and installs them **only when the user starts it**.
Leuchtturm never installs anything on its own.

It never replaces or modifies VS Code's marketplace configuration (`product.json`). It only uses
public VS Code APIs, so it stays within the VS Code / Marketplace terms.

---

## 1. Goals and non-goals

### Goals (v1)
- Check configured sources **once per hour** by default. The interval and behaviour are fully configurable through settings.
- Give **clear visibility**: a sidebar view, a status bar item, notifications and an output channel.
- Support four source types:
  1. `file` — a local folder or network share full of `.vsix` files (similar to VSIX Manager).
  2. `npm` — any npm registry (Nexus, Artifactory, Verdaccio) holding VSIX files wrapped in npm packages (similar to Garmin's Private Extension Manager).
  3. `http` — a two-step HTTP request flow for Jenkins and similar servers. Step one fetches an index page or API, a regex matcher extracts versions, and step two builds the download request from the captured values.
  4. `script` — a fully custom user script (Python preferred) that talks to Leuchtturm through a small JSON protocol over stdout.
- **Never install automatically.** A check only notifies the user and updates the sidebar. Installing always starts from an explicit user action: a button in the sidebar or a command. There is no setting to change this.
- Install updates with `workbench.extensions.installExtension`, then offer a window reload.
- Document every source type, with example files.

### Non-goals (v1), but keep the design open for them
- Updating things that are not VS Code extensions: plain directories, CLI tools, binaries. §13 sketches the planned *directory* target. The source/target split in §4 must make it a later addition, not a rewrite. Name internal types generically (`Artifact`, `Target`, `kind`) and not `Extension` wherever practical.
- Publishing to the sources. Leuchtturm only consumes them.
- Signing or verification infrastructure beyond the checks in §9.

---

## 2. Identity

| Field | Value |
|---|---|
| Display name | Leuchtturm Updater |
| `name` | `leuchtturm-updater` |
| `publisher` | placeholder `armaxri`. Use a publisher ID that is not claimable on the public Marketplace for company builds. |
| Command / setting prefix | `leuchtturm` |
| Icon | `media/icon.png` (256×256, source `media/icon.svg`) |
| Activity bar icon | `media/activitybar.svg` (monochrome, `currentColor`) |
| License | MIT |
| `extensionKind` | `["ui"]`. The updater runs on the local machine, where file shares and Jenkins are reachable and where `installExtension` targets the local extension host. Document the behaviour with Remote-SSH, WSL and Dev Containers. |
| Engine | `vscode` ≥ 1.90, so Node 18+ and global `fetch` are available. |

---

## 3. User-facing features

### 3.1 Sidebar view ("Leuchtturm")
A view container in the activity bar holds one tree view:

```
Leuchtturm
├─ ⬆ Updates available (2)
│   ├─ Corp Linter        1.3.0 → 1.4.1   [jenkins]   (inline actions: Update · Release notes · Skip)
│   └─ Corp Snippets      0.9.0 → 1.0.0   [share]
├─ ✓ Up to date (3)
│   └─ Corp Theme         2.1.0           [nexus]
├─ ✚ Available, not installed (1)       (inline action: Install)
└─ ⚠ Problems (1)
    └─ jenkins: HTTP 401 — check credentials       (click: open output channel)
```

- Expanding an extension node lists all available versions. The context menu offers "Install this version", which covers downgrades and pinning.
- The view title bar has: *Check now*, *Update all*, *Open settings*, *Show log*.
- Each node has a tooltip with the source name, the source type, the last check time and the release notes when available.

### 3.2 Status bar
- An item on the left side: `$(broadcast) 2` when updates exist, hidden or dimmed when there are none (setting `leuchtturm.statusBar`: `"always" | "whenUpdates" | "never"`, default `whenUpdates`).
- Clicking it focuses the sidebar view.
- While a check runs, show `$(sync~spin)`.

### 3.3 Notifications
When a check finds **new** updates (not already announced, not skipped) and `leuchtturm.notify` is on, show a message. It points the user to the sidebar and never installs from the notification itself:

> Leuchtturm: **Corp Linter 1.4.1** is available (installed 1.3.0). — **Show in Leuchtturm** · Skip this version · Later

- When several updates are found, show one combined message: "Leuchtturm: 3 updates available — **Show in Leuchtturm** · Later".
- "Show in Leuchtturm" reveals the sidebar view with the update nodes selected. The user starts the install there with *Update* on a node or *Update all* in the view title.
- Announce each `(id, version)` only once, so hourly checks don't nag. The badge on the activity bar icon (`TreeView.badge`) and the status bar item stay visible until the update is installed or skipped.
- "Skip this version" is stored in `globalState`. The skipped version shows greyed out in the tree.
- After installing, show "Reload window to activate Corp Linter 1.4.1? — **Reload** · Later".

### 3.4 Commands
| Command | Title |
|---|---|
| `leuchtturm.checkNow` | Leuchtturm: Check for Updates |
| `leuchtturm.updateAll` | Leuchtturm: Update All |
| `leuchtturm.update` | Leuchtturm: Update Extension… (quick pick) |
| `leuchtturm.installVersion` | Leuchtturm: Install Specific Version… |
| `leuchtturm.setSecret` | Leuchtturm: Store Credential… (SecretStorage) |
| `leuchtturm.clearSkipped` | Leuchtturm: Reset Skipped Versions |
| `leuchtturm.showLog` | Leuchtturm: Show Log |
| `leuchtturm.testSource` | Leuchtturm: Test Source… (runs one source and prints raw results and matches; essential for regex and script debugging) |

### 3.5 Output channel
A `LogOutputChannel` named "Leuchtturm Updater". At `debug` level it logs every request URL with credentials redacted, every regex match and the raw script stdout/stderr.

---

## 4. Architecture

```
src/
  extension.ts            activate/deactivate, wiring
  config.ts               read + validate settings, variable substitution (§7)
  scheduler.ts            interval timer, cross-window lock (§8)
  checker.ts              runs all sources, merges results, computes update state
  installer.ts            download → verify → installExtension → reload prompt
  version.ts              semver compare (no dependency needed; handle prerelease)
  state.ts                globalState: skipped versions, last check, cached results
  sources/
    types.ts              Source interface + Artifact types
    fileSource.ts
    npmSource.ts
    httpSource.ts
    scriptSource.ts
    index.ts              factory: type → implementation
  ui/
    treeView.ts
    statusBar.ts
    notifications.ts
  util/
    http.ts               fetch wrapper: headers, auth, timeout, proxy, TLS options
    vsix.ts               read extension/package.json from a .vsix (zip) for verification
    template.ts           ${var} substitution
```

### 4.1 Core types

```ts
interface AvailableVersion {
  version: string;           // semver
  releaseNotes?: string;     // markdown or plain text
  releaseNotesUrl?: string;
  sha256?: string;           // optional integrity check
  // opaque, source-specific data needed for download (e.g. captured regex groups, tarball URL)
  ref: Record<string, string>;
}

interface Artifact {
  id: string;                // "publisher.name" for VS Code extensions
  displayName?: string;
  kind: 'vscode-extension';  // future: 'file' | 'binary' | ...
  versions: AvailableVersion[];
}

interface Source {
  readonly name: string;
  readonly type: 'file' | 'npm' | 'http' | 'script';
  list(token: CancellationToken): Promise<Artifact[]>;
  /** Returns an absolute path to a downloaded .vsix inside targetDir. */
  download(artifact: Artifact, version: AvailableVersion, targetDir: string,
           token: CancellationToken): Promise<string>;
}
```

### 4.2 Check flow
1. Load sources from settings. Invalid sources go to "Problems" and do not abort the others.
2. Run `list()` on all sources in parallel, with a per-source timeout.
3. Determine which artifacts to track (§6.2), compare them with `vscode.extensions.getExtension(id)?.packageJSON.version` and build the state: update, up-to-date, not-installed, skipped, error.
4. If the same ID appears in more than one source, use the explicit mapping in `leuchtturm.extensions` first. Otherwise take the highest version and break ties by source order.
5. Update the tree, the status bar, the activity bar badge and the notifications. A check **never** calls the installer.

### 4.3 Install flow
1. `download()` into `context.globalStorageUri/downloads/`.
2. Verify the file (§9).
3. `await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(path))`.
4. Delete the download, refresh the state and prompt for a reload. When several installs run together, show one reload prompt at the end.
5. Run installs sequentially and show progress through `window.withProgress`.

---

## 5. Settings

All settings that can define something executable or credential-bearing (`leuchtturm.sources`)
use `"scope": "machine"`. That stops a cloned repository's `.vscode/settings.json` from injecting a
malicious script or download URL. Behavioural settings use `"scope": "application"` or the default.

| Setting | Type | Default | Description |
|---|---|---|---|
| `leuchtturm.enabled` | boolean | `true` | Master switch. |
| `leuchtturm.checkInterval` | number (minutes) | `60` | `0` disables periodic checks. Minimum 5. |
| `leuchtturm.checkOnStartup` | boolean | `true` | Check after activation (delayed by about 10 s). |
| `leuchtturm.notify` | boolean | `true` | Show a notification for newly found updates. If `false`, only the sidebar, badge and status bar show them. There is intentionally no auto-install option. |
| `leuchtturm.includePrerelease` | boolean | `false` | Consider semver prerelease versions. |
| `leuchtturm.statusBar` | enum | `"whenUpdates"` | See §3.2. |
| `leuchtturm.sources` | object | `{}` | Named sources, see §6. |
| `leuchtturm.extensions` | array | `[]` | Which extensions to track and from where, see §6.2. |
| `leuchtturm.trackAllFromSources` | boolean | `false` | If `true`, every artifact any source offers appears in the tree under "Available, not installed". |
| `leuchtturm.http.timeout` | number (s) | `30` | Default request timeout. |
| `leuchtturm.script.timeout` | number (s) | `120` | Default script timeout. |
| `leuchtturm.script.enabled` | boolean | `false` | **Opt-in gate for `script` sources.** `"scope": "machine"`, and only the **user-level** value counts (§6.5). |

Respect VS Code's `http.proxy`, `http.proxyStrictSSL` and `http.proxyAuthorization` where
possible. Node's `fetch` does not pick them up automatically, so use `undici`'s `ProxyAgent` or
document the limitation.

---

## 6. Source types

Every source has these common fields:

```jsonc
{
  "type": "file" | "npm" | "http" | "script",
  "enabled": true,           // optional
  "timeout": 30,             // optional, seconds
  "include": ["corp.*"],     // optional glob filter on extension IDs
  "exclude": []
}
```

### 6.1 `file`: folder or network share

```jsonc
"leuchtturm.sources": {
  "share": {
    "type": "file",
    "path": "\\\\fileserver\\vscode-extensions",   // or "~/vsix", "/Volumes/tools/vsix"
    "recursive": false,
    // optional, default shown: named groups id + version are required
    "filePattern": "^(?<id>[\\w-]+\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)\\.vsix$"
  }
}
```

- Lookup follows VSIX Manager: `<path>/<id>-<v>.vsix`, `<path>/<publisher>/<id>-<v>.vsix`, `<path>/<id>/<id>-<v>.vsix`.
- `~` expands on all operating systems.
- `download()` copies the file into `targetDir`. Never install directly from a share path, because the share may change mid-install.
- Optional sidecar `<file>.vsix.sha256` and `<file>.md` (release notes) are picked up when present.

### 6.2 Tracking extensions

```jsonc
"leuchtturm.extensions": [
  "corp.linter",                                 // any source that offers it
  "share:corp.snippets",                         // only from source "share"
  { "id": "corp.theme", "source": "nexus", "pin": "2.1.x" },   // optional semver range
  { "id": "corp.legacy", "enabled": false }
]
```

If the list is empty, Leuchtturm tracks every **installed** extension that any source offers.
This zero-config default is the important one: point it at a share and it works.

### 6.3 `npm`: npm registry
Behaviour matches Garmin's Private Extension Manager, so teams can migrate easily.

```jsonc
"nexus": {
  "type": "npm",
  "registry": "https://nexus.corp.example/repository/npm-internal/",
  "scope": "@corp-vscode",             // optional: list via search API / restrict to scope
  "packages": ["@corp-vscode/linter"], // optional explicit list (search APIs differ between registries)
  "auth": { "token": "${secret:nexus-token}" }   // or read from ~/.npmrc
}
```

- Use the registry HTTP API directly (`GET <registry>/<package>` → packument), with no npm CLI dependency.
- Package convention: the npm package contains exactly one `.vsix` file at its root. `package.json` has a `"vscodeExtension": "corp.linter"` field, or Leuchtturm derives the ID from the `.vsix` inside.
- `download()` fetches the tarball (`dist.tarball`), checks `dist.integrity`, extracts the `.vsix`.
- Read `~/.npmrc` for `//host/:_authToken=` if `auth` is not given.
- Write **`docs/sources/npm.md`** covering how to package (`vsce package`), the minimal `package.json`, `npm publish --registry`, and how CI should do it. Add `examples/npm/package.json` and `examples/npm/publish.sh`.

### 6.4 `http`: two-step request (Jenkins and others)

Step 1 is the **index request**, step 2 the **matcher**, step 3 the **download request**.

```jsonc
"jenkins-linter": {
  "type": "http",
  "index": {
    "url": "https://jenkins.corp.example/job/corp-linter/api/json?tree=builds[number,result,artifacts[fileName,relativePath]]{0,20}",
    "method": "GET",
    "headers": { "Authorization": "Basic ${secret:jenkins-basic}" },
    "strictSSL": true
  },
  "match": {
    // applied to the response body; global, all matches collected
    "regex": "\"fileName\":\"(?<id>corp\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+)\\.vsix\",\"relativePath\":\"(?<path>[^\"]+)\"",
    "flags": "g",
    // optional: fixed id if the file name does not contain it
    "id": null,
    // optional: alternative to regex for JSON responses
    "jsonPath": null
  },
  "download": {
    // all named groups + ${id} + ${version} are available
    "url": "https://jenkins.corp.example/job/corp-linter/lastSuccessfulBuild/artifact/${path}",
    "headers": { "Authorization": "Basic ${secret:jenkins-basic}" }
  },
  "releaseNotes": { "url": "https://jenkins.corp.example/job/corp-linter/lastSuccessfulBuild/artifact/CHANGELOG.md" }
}
```

- Required named groups: `version`, and `id` unless `match.id` is set. Every other named group is stored in `ref` and can be used in templates.
- Deduplicate by `(id, version)`. The first match wins, so an index sorted newest-first does the right thing.
- Auth options: header templates, `"auth": { "basic": { "user": "...", "password": "${secret:...}" } }`, `"auth": { "bearer": "${env:TOKEN}" }`.
- For servers that only allow a weak TLS setup, support `"strictSSL": false` with a visible warning in the log and the tree tooltip. Also support `"ca": "/path/to/corp-ca.pem"`.
- **`leuchtturm.testSource`** is the main UX for this type. It prints the status, the first 2 KB of the body, every match with its groups, and the resolved download URLs.
- Docs: `docs/sources/http.md`, with full examples for Jenkins (JSON API, plus the "directory listing" HTML variant), a plain Apache or nginx autoindex, an Artifactory folder listing, and a GitLab or Gitea generic packages API.

### 6.5 `script`: fully custom handling over JSON

The user writes a script, Python preferred but any executable works. Leuchtturm runs it with
predefined arguments and reads **JSON from stdout**. Logs go to **stderr**, which Leuchtturm
forwards to the output channel. With this, teams can integrate any environment without
building their own extension.

**Opt-in gate.** Script sources are ignored unless the user turns them on in their **user settings**:

```jsonc
// User settings (settings.json), not workspace settings
"leuchtturm.script.enabled": true
```

- Read the value with `workspace.getConfiguration('leuchtturm').inspect('script.enabled')` and use **only `globalValue`**. Ignore `workspaceValue` and `workspaceFolderValue` even if they are present. This is defence in depth on top of `"scope": "machine"`.
- If the gate is off, never spawn a script source. Show it in the tree under "Problems" as *"Script sources are disabled — enable `leuchtturm.script.enabled` in your user settings"*, with an action that opens the user settings at that key.
- The gate is checked again right before every spawn, not only at load time, so turning it off takes effect immediately.
- Optionally (nice to have) show a one-time confirmation when a script source runs for the first time or its `command`/`script` path changes: "Leuchtturm will run `python3 ~/tools/leuchtturm_source.py`. Allow?". Store the approval per command+path hash in `globalState`.

```jsonc
"custom": {
  "type": "script",
  "command": "python3",                          // executable; on Windows e.g. "py"
  "script": "~/tools/leuchtturm_source.py",      // optional: prepended to args
  "cwd": "~/tools",                              // optional
  "env": { "ARTIFACT_HOST": "https://files.corp.example" },
  "timeout": 120,
  // optional: override any argument list; defaults shown
  "args": {
    "list":     ["get_versions"],
    "download": ["download_version", "--id", "${id}", "--version", "${version}", "--target-dir", "${targetDir}"],
    "notes":    ["get_release_notes", "--id", "${id}", "--version", "${version}"]
  }
}
```

**Process contract**
- Run with `child_process.spawn` with `shell: false`. Template-substitute every argument separately so there is no shell injection. Leuchtturm also sets these environment variables:
  - `LEUCHTTURM_PROTOCOL=1`
  - `LEUCHTTURM_ACTION=list|download|notes`
  - `LEUCHTTURM_ID`, `LEUCHTTURM_VERSION`, `LEUCHTTURM_TARGET_DIR` for actions that need them
  - `LEUCHTTURM_VSCODE_VERSION`, `LEUCHTTURM_PLATFORM` (`win32-x64`, `darwin-arm64`, …)
- stdout must contain exactly one JSON document. If there is extra output, parse the **last line** that is valid JSON and log a warning.
- A non-zero exit code is an error. Show stderr's last line in "Problems".
- Kill on timeout or cancellation (tree kill on Windows).

**`list` response** (`get_versions`)
```json
{
  "protocol": 1,
  "artifacts": [
    {
      "id": "corp.linter",
      "displayName": "Corp Linter",
      "versions": [
        { "version": "1.4.1", "releaseNotes": "- Fix crash on empty file", "sha256": "…", "ref": { "build": "312" } },
        { "version": "1.4.0", "ref": { "build": "298" } }
      ]
    }
  ]
}
```
`ref` is opaque. Leuchtturm passes it back on download as `${ref.<key>}` in args and as `LEUCHTTURM_REF_<KEY>` env vars.

**`download` response** (`download_version`): one of these:
```json
{ "protocol": 1, "path": "/abs/path/inside/target-dir/corp.linter-1.4.1.vsix" }
{ "protocol": 1, "url": "https://files.corp.example/corp.linter-1.4.1.vsix", "headers": { "Authorization": "…" } }
```
With `url`, Leuchtturm downloads the file itself. That lets scripts that only resolve URLs stay tiny.

**`notes` response** (optional action; scripts may exit with code 3 = "not supported"):
```json
{ "protocol": 1, "markdown": "## 1.4.1\n- Fix crash…" }
```

**Error response** (allowed instead of the above, with exit code 1):
```json
{ "protocol": 1, "error": "Artifact server unreachable", "detail": "…" }
```

Validate every response against a JSON schema (`schemas/script-protocol.schema.json`, shipped and documented). Show useful validation errors in the log.

**Examples to ship** (Python 3.8+, standard library only, each runnable stand-alone for testing):
- `examples/script/minimal_static.py`: hard-coded list, prints `url` on download. The "hello world".
- `examples/script/folder_source.py`: scans a folder or share, shows `path` download and sha256.
- `examples/script/jenkins_source.py`: Jenkins JSON API with credentials from env vars, shows `ref` usage.
- `examples/script/manifest_source.py`: reads a `versions.json` manifest from an HTTP server.
- `examples/script/_leuchtturm.py`: a tiny helper module (argument parsing, `emit()`, `fail()`) that the others import. Users can copy it.
- `examples/script/README.md`: how to try each one on the command line (`python3 minimal_static.py get_versions | python3 -m json.tool`), plus the matching settings snippet.
- Docs: `docs/sources/script.md`, the full protocol reference, generated from or kept in sync with the schema.

---

## 7. Variables and secrets

Template substitution works in URLs, headers, args, env and paths:

| Variable | Meaning |
|---|---|
| `${id}`, `${version}`, `${targetDir}` | Current operation |
| `${<group>}` | Named regex group (http source) |
| `${ref.<key>}` | Script `ref` value |
| `${env:NAME}` | Environment variable |
| `${secret:NAME}` | Value from VS Code `SecretStorage`, set with `leuchtturm.setSecret` |
| `${userHome}`, `~` | Home directory |
| `${platform}` | e.g. `win32-x64`, for platform-specific VSIX |

An unknown variable is a configuration error and must not be replaced with an empty string. Secret values are **redacted** in all logs.

---

## 8. Scheduling and multi-window behaviour
- Every VS Code window activates the extension. To avoid N parallel checks, use a lock in `globalState`: `{ owner: <sessionId>, until: <timestamp> }`. Only the owner checks, and the other windows read the cached result from `globalState` and refresh their UI via `onDidChange` polling, or a cheap check every minute.
- Never install the same artifact from two windows. Hold an install lock per ID.
- A manual "Check now" always runs, regardless of the lock.
- Back off on errors: if a source fails, retry after `min(interval, 5 min × 2^n)`.

## 9. Safety and verification
1. **No automatic installs.** Every install starts from a user action (§1, §3.3).
2. The `leuchtturm.sources` setting is `machine`-scoped (§5). Never read any source from workspace settings.
3. `script` sources need the user-level opt-in `leuchtturm.script.enabled` (§6.5). Without it, scripts are ignored.
4. Before installing, open the `.vsix` (zip) and read `extension/package.json`. `publisher.name` must equal the expected ID and `version` must equal the expected version. Otherwise abort with a clear error. This is cheap: one zip entry read with `yauzl`/`fflate`, about 30 lines.
5. If a `sha256` or npm `integrity` is known, verify it.
6. Installing a **downgrade** (via "Install this version") or a VSIX whose `publisher` differs from the tracked ID needs an extra modal confirmation.
7. Log the source and URL of every install.

## 10. Quality
- TypeScript strict mode, ESLint, Prettier.
- Bundle with esbuild into `dist/extension.js`. Keep runtime dependencies minimal: allowed are a zip reader (`yauzl` or `fflate`), a tar reader for npm tarballs, and optionally `undici` for proxies. Prefer no others.
- Unit tests (vitest or mocha) for `version.ts`, `template.ts`, each source using local fixtures (a temp folder, a local HTTP server, a fake registry, fake scripts), and script protocol validation.
- Integration tests with `@vscode/test-electron` covering one end-to-end check plus install against a fixture VSIX.
- CI: GitHub Actions on Windows, macOS and Linux runs lint, tests and `vsce package`.
- Package with `vsce package`. Publishing to the public Marketplace or Open VSX is optional, and is fine because the extension itself contains nothing company-specific.

## 11. Documentation deliverables
- `README.md`: what it is, a 2-minute quick start (file share), a screenshot of the tree, links to the per-source docs.
- `docs/sources/file.md`, `npm.md`, `http.md`, `script.md`.
- `docs/configuration.md`: every setting, variables, secrets.
- `docs/security.md`: why sources are machine-scoped, verification steps, and how this relates to the VS Code / Marketplace terms (official VS Code, own extensions, documented API, marketplace config untouched).
- `examples/` as listed in §6.3 and §6.5, plus `examples/settings/*.jsonc` with one complete snippet per source type.
- `CHANGELOG.md`.

## 12. Milestones (implement in this order, each one shippable)
1. **M1 Skeleton**: scaffold, esbuild, lint, tests, CI; `version.ts`, `template.ts`, config loading; `file` source; check, notification and install; output channel.
2. **M2 Visibility**: tree view, status bar, scheduler with cross-window lock, skip version, Update all, Test Source.
3. **M3 HTTP**: `http` source with regex matcher, auth, secrets, TLS options; Jenkins docs and examples.
4. **M4 npm**: `npm` source, `.npmrc` auth, tarball extraction; publishing guide and examples.
5. **M5 Script**: `script` source with the user-level opt-in gate, JSON schema, Python examples and helper, protocol docs.
6. **M6 Polish**: VSIX verification, proxy support, README screenshots, `CHANGELOG`, v1.0.0.
7. **M7 (post-1.0) Directories**: the `directory` target kind from §13.

## 13. Later: directory targets (first step towards updating other tools)

Goal: keep a **plain directory** up to date with the same sources, UI and notify-then-manual-install flow. Examples: a shared config folder, a set of scripts, a portable CLI tool.

### 13.1 Target configuration

```jsonc
"leuchtturm.targets": [
  {
    "id": "corp.build-scripts",          // free-form ID; must match the artifact ID the source reports
    "kind": "directory",
    "source": "jenkins-scripts",
    "path": "~/tools/build-scripts",     // install location
    "versionFile": ".leuchtturm-version" // written after install; holds the installed version
  }
]
```

Like `leuchtturm.sources`, `leuchtturm.targets` is `"scope": "machine"`, because it decides where files are written.

### 13.2 How a source delivers a directory
- `file` source: a sub-folder `<id>-<version>/`, or an archive `<id>-<version>.zip` / `.tar.gz`.
- `http` source: the download URL points to a `.zip` or `.tar.gz`. A `"format"` field selects the extractor; otherwise it comes from the extension or `Content-Type`.
- `npm` source: the package tarball content *is* the directory, so no inner VSIX is needed.
- `script` source: `download_version` returns `{ "path": "<dir or archive>" }`. Add `"kind": "directory"` to the artifact in the `get_versions` output.

### 13.3 Install semantics (safe replace)
1. Download and extract into a staging folder next to the target: `<path>.leuchtturm-staging/`.
2. Reject archive entries with `..` or absolute paths (zip-slip protection).
3. Rename the current `<path>` to `<path>.leuchtturm-backup/`, rename staging to `<path>`, write `versionFile`, then delete the backup. On any error, roll back from the backup.
4. Optional `"preserve": ["config.local.json"]` copies listed files from the old directory into the new one.
5. Optional `"postInstall"`: a command run with `spawn` (no shell), gated by the same user-level opt-in as script sources.
6. Show these targets in the same tree, grouped by kind ("VS Code extensions", "Directories"), with the same *Update* action and the same "never automatic" rule.

### 13.4 What this means for v1 code
- `Artifact.kind` and a `Target` abstraction exist from M1. `VsCodeExtensionTarget` implements `getInstalledVersion()` and `install(downloadedPath)`.
- `Source.download()` returns a path that may be a file **or** a directory.
- The tree groups by `kind` from the start, even while only one kind exists.

