# `file` source: folder or network share

The simplest source: a folder full of `.vsix` files. It can be a local folder, a mounted
network drive, or a UNC path on Windows.

```jsonc
// User settings (settings.json)
"leuchtturm.sources": {
  "share": {
    "type": "file",
    "path": "\\\\fileserver\\vscode-extensions"   // or "~/vsix", "/Volumes/tools/vsix"
  }
}
```

With no `leuchtturm.extensions` list, Leuchtturm now tracks every **installed** extension that
the share offers. That is the whole setup.

## Options

| Field                 | Default                        | Description                                                                                         |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `type`                |                                | `"file"`                                                                                            |
| `path`                | (required)                     | Folder to scan. Supports `~`, `${userHome}` and `${env:NAME}`.                                      |
| `recursive`           | `false`                        | Scan every sub-folder level instead of the layouts below.                                           |
| `filePattern`         | see below                      | Regex for file names. Must contain the named groups `id` and `version`. Matched case-insensitively. |
| `enabled`             | `true`                         | Set to `false` to switch the source off without deleting it.                                        |
| `timeout`             | `leuchtturm.http.timeout` (30) | Seconds before listing the folder is aborted. Useful for slow shares.                               |
| `include` / `exclude` | `[]`                           | Glob filters on extension IDs, e.g. `["corp.*"]`.                                                   |

Default `filePattern`:

```
^(?<id>[\w-]+\.[\w-]+)-(?<version>\d+\.\d+\.\d+(?:-[\w.]+)?)\.vsix$
```

It matches the names `vsce package` produces, such as `corp.linter-1.4.1.vsix` or
`corp.linter-2.0.0-beta.1.vsix`. In JSON settings every backslash must be doubled.

## Folder layouts

Without `recursive`, these layouts are recognised (same as VSIX Manager):

```
<path>/corp.linter-1.4.1.vsix                 flat
<path>/corp/corp.linter-1.4.1.vsix            one folder per publisher
<path>/corp.linter/corp.linter-1.4.1.vsix     one folder per extension
```

A file in a sub-folder whose name is neither the publisher nor the extension ID is ignored, as
is anything deeper than one level. Use `"recursive": true` for other structures.

Files whose version is not valid semver are skipped (visible in the log at debug level).

## Debugging

Run **Leuchtturm: Test Source…** and pick the source. The log then lists every `.vsix` file
with the decision and its reason (matched, does not match the pattern, not semver, wrong
folder), sub-folders that were not scanned, and the resulting versions with their file paths.

## Sidecar files

Optional files next to a VSIX are picked up automatically:

| File                                                  | Meaning                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `corp.linter-1.4.1.vsix.sha256`                       | SHA-256 of the VSIX. `sha256sum` output works as is. Leuchtturm refuses to install a file that does not match. |
| `corp.linter-1.4.1.md` or `corp.linter-1.4.1.vsix.md` | Release notes (Markdown).                                                                                      |

Creating them in CI:

```sh
vsce package -o dist/
cd dist
for f in *.vsix; do sha256sum "$f" > "$f.sha256"; done
cp ../CHANGELOG-latest.md "$(ls *.vsix | head -n1 | sed 's/\.vsix$/.md/')"
```

## How installing works

On _Update_ or _Install Specific Version…_, Leuchtturm copies the VSIX from the share into
its own storage folder, verifies the SHA-256 if a sidecar exists, installs it with VS Code's
`workbench.extensions.installExtension` command, and deletes the copy. It never installs
straight from the share, because the share may change mid-install.

## Examples

A complete settings snippet is in [`examples/settings/file.jsonc`](../../examples/settings/file.jsonc).
