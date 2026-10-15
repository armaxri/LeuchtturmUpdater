# Changelog

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
