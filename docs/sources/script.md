# `script` source: your own program, a small JSON protocol

When no built-in source fits, write a script. Leuchtturm runs it with fixed arguments and reads
one JSON document from its stdout. Python is the natural choice (the examples use only the
standard library), but any executable works.

**Servers that need a login are reached this way.** Leuchtturm itself handles no credentials:
your script signs in however your company does it (environment variables, a keyring, a token
file, single sign-on tooling), lists the extensions and downloads them. Leuchtturm never sees
the login.

```jsonc
// User settings (settings.json)
"leuchtturm.script.enabled": true,
"leuchtturm.sources": {
  "custom": {
    "type": "script",
    "command": "python3",                       // on Windows: "py" or "python"
    "script": "~/tools/leuchtturm_source.py",
    "env": { "ARTIFACT_HOST": "https://files.corp.example" }
  }
}
```

## Turning scripts on

Script sources run programs on your machine, so two things must happen first:

1. **`leuchtturm.script.enabled` must be `true` in your user settings.** Only the user-level
   value counts. A workspace's `.vscode/settings.json` cannot turn it on, and
   `leuchtturm.sources` itself is only read from user settings. While it is off, the source
   shows up under _Problems_; clicking it opens the setting. The setting is checked again
   right before every run, so turning it off stops scripts at once.
2. **You approve the program once.** The first time a source runs, or after its `command` or
   `script` path changed, Leuchtturm asks: _"source custom wants to run `python3
~/tools/leuchtturm_source.py`"_. Choose _Review and Allow…_, or click the problem node, or
   run **Leuchtturm: Allow Script Source…**. Approvals are stored per command and script path.

## Options

| Field                           | Default                           | Description                                                                                                                                                                              |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                       | (required)                        | Executable: a name on the `PATH` (`python3`) or a path (`~/venv/bin/python`). Started **without a shell**. On Windows, use an `.exe` (`py`, `python`, `node`), not a `.cmd`/`.bat` file. |
| `script`                        |                                   | Script file, passed as the first argument. Supports `~`.                                                                                                                                 |
| `cwd`                           |                                   | Working directory.                                                                                                                                                                       |
| `env`                           | `{}`                              | Extra environment variables. Values support `${env:NAME}`. The script also gets your normal environment.                                                                                 |
| `args`                          | see below                         | Argument lists per action.                                                                                                                                                               |
| `timeout`                       | `leuchtturm.script.timeout` (120) | Seconds per run. The process tree is killed after that.                                                                                                                                  |
| `include`, `exclude`, `enabled` |                                   | As for every source.                                                                                                                                                                     |

Default `args`:

```jsonc
"args": {
  "list":     ["get_versions"],
  "download": ["download_version", "--id", "${id}", "--version", "${version}", "--target-dir", "${targetDir}"],
  "notes":    ["get_release_notes", "--id", "${id}", "--version", "${version}"]
}
```

Every argument is templated on its own and passed as one argument, so a value can never
turn into extra arguments or shell syntax. Available variables: `${id}`, `${version}` and
`${targetDir}` (download), `${id}` and `${version}` (notes), `${ref.<key>}`, `${env:NAME}`,
`${userHome}`, `${platform}`. Set `"notes": null` if your script has no
release notes.

## Protocol (version 1)

### Environment

| Variable                              | Value                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `LEUCHTTURM_PROTOCOL`                 | `1`                                                                                  |
| `LEUCHTTURM_ACTION`                   | `list`, `download` or `notes`                                                        |
| `LEUCHTTURM_ID`, `LEUCHTTURM_VERSION` | The artifact (download, notes)                                                       |
| `LEUCHTTURM_TARGET_DIR`               | Folder to download into (download)                                                   |
| `LEUCHTTURM_REF_<KEY>`                | Each `ref` value of the version, key uppercased (`my-key` → `LEUCHTTURM_REF_MY_KEY`) |
| `LEUCHTTURM_VSCODE_VERSION`           | e.g. `1.95.0`                                                                        |
| `LEUCHTTURM_PLATFORM`                 | e.g. `win32-x64`, `darwin-arm64`, `linux-x64`                                        |

### Output rules

- stdout holds **exactly one JSON document**. If there is other output, Leuchtturm uses the
  last line that is valid JSON and logs a warning. Print logs to **stderr**; Leuchtturm
  forwards them to its output channel (debug level) and to _Test Source_.
- Exit code `0`: success. Non-zero: error; Leuchtturm shows the last stderr line under
  _Problems_, or the `error` of an error response. Exit code `3` from `notes` means
  "not supported".
- Every response is validated against
  [`schemas/script-protocol.schema.json`](../../schemas/script-protocol.schema.json). Validation
  errors name the exact field, e.g. `artifacts[0].versions[1].version: "1.0" must be a semver
version such as 1.4.1 or 2.0.0-beta.1`.

### `list` (`get_versions`)

```json
{
  "protocol": 1,
  "artifacts": [
    {
      "id": "corp.linter",
      "displayName": "Corp Linter",
      "versions": [
        {
          "version": "1.4.1",
          "releaseNotes": "- Fix crash on empty file",
          "sha256": "…",
          "ref": { "build": "312" }
        },
        { "version": "1.4.0", "ref": { "build": "298" } }
      ]
    }
  ]
}
```

| Field                            | Required | Description                                                                                           |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `artifacts[].id`                 | yes      | `publisher.name`                                                                                      |
| `artifacts[].displayName`        |          | Shown in the sidebar.                                                                                 |
| `artifacts[].kind`               |          | `"vscode-extension"` (the default; other kinds come later).                                           |
| `artifacts[].versions[].version` | yes      | Semver.                                                                                               |
| `…releaseNotes`                  |          | Markdown or plain text.                                                                               |
| `…releaseNotesUrl`               |          | Opened in the browser when there are no inline notes.                                                 |
| `…sha256`                        |          | Hex SHA-256 of the `.vsix`. Leuchtturm refuses a download that does not match.                        |
| `…ref`                           |          | Opaque string values, passed back on download and notes as `${ref.<key>}` and `LEUCHTTURM_REF_<KEY>`. |

### `download` (`download_version`)

Either a path:

```json
{ "protocol": 1, "path": "/abs/path/inside/target-dir/corp.linter-1.4.1.vsix" }
```

Write the file into the target directory. A path elsewhere is copied there first, so your
file is never deleted; a relative path is resolved against the target directory.

Or a URL that Leuchtturm downloads. It sends no credentials, so this is only for files that
need no login; otherwise download the file yourself and answer with its path.

```json
{ "protocol": 1, "url": "https://files.corp.example/corp.linter-1.4.1.vsix" }
```

### `notes` (`get_release_notes`), optional

```json
{ "protocol": 1, "markdown": "## 1.4.1\n- Fix crash…" }
```

Exit with code `3` if there are no notes. Leuchtturm only runs this action when you click
_Release notes_ and the version has no inline `releaseNotes`.

### Errors (any action)

```json
{ "protocol": 1, "error": "Artifact server unreachable", "detail": "…" }
```

Exit with code `1`. `error` appears under _Problems_, `detail` (e.g. a traceback) in the log.

## Examples

[`examples/script/`](../../examples/script/) has runnable Python examples (3.8+, standard
library only) and a helper module, `_leuchtturm.py`, with argument parsing, `emit()`, `fail()`
and `ref()`. Start with `minimal_static.py`; the README there shows how to run each one on
the command line.

## Debugging with Test Source

**Leuchtturm: Test Source…** shows the exact command line (each argument quoted), every
stderr line, the exit code, the raw stdout and any validation errors.
