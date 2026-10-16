# Security

Leuchtturm downloads and installs code, and can run scripts. These are the safeguards.

## Nothing installs on its own

Checks only update the sidebar, the badge, the status bar and send notifications. Every install
starts from a click (_Update_, _Update All_, _Install This Version_) or a command. There is no
setting for automatic installs, and notifications never install from their buttons.

## Sources come from your user settings only

`leuchtturm.sources` (and `leuchtturm.script.enabled`) have `"scope": "application"`, so VS
Code ignores them in workspace and folder settings, and in the Remote settings of a container or
SSH host. Leuchtturm additionally reads only the user-level value (`inspect().globalValue`). A
cloned repository's `.vscode/settings.json` or a dev container's configuration can therefore not
add a download location or turn on scripts.

## Remote windows

Leuchtturm runs on your local machine, also in Dev Containers, Remote-SSH and WSL windows. To see
the extensions installed on the remote side, it needs its helper there (see the
[README](../README.md#remote-development)). The helper ships inside Leuchtturm's own package, is
only installed when you click _Install Helper_, and does one thing: it answers Leuchtturm with
the IDs and versions of the extensions installed next to it. It has no settings, opens no network
connections and runs no programs.

## Script sources

- Off unless `leuchtturm.script.enabled` is `true` in your **user** settings, re-checked right
  before every run.
- Each program needs a one-time approval, stored per command and script path. Changing either
  asks again.
- Programs start with `spawn` and **no shell**; every argument is templated separately, so
  values from a server cannot inject shell syntax or extra arguments.
- A run that exceeds its timeout, or is cancelled, has its whole process tree killed.
- Responses are validated against a published JSON schema.

## Verification before installing

- `sha256` from a `.sha256` sidecar or a script response is checked; a mismatch aborts.
- npm downloads are checked against the registry's `dist.integrity` (or `dist.shasum`).
- Downgrades need a modal confirmation.
- Every install logs its source and URL.
- Every `.vsix` is opened before installing: `extension/package.json` must name the offered
  extension and version, otherwise nothing is installed. A different publisher with the same
  name needs a modal confirmation.

## Credentials

- Store passwords and tokens with **Leuchtturm: Store Credential…**. They live in VS Code's
  secret storage, encrypted by the operating system's keychain, and settings refer to them as
  `${secret:NAME}`.
- All log output passes through a redactor: stored secrets, derived values (such as the
  base64 of basic auth), `Authorization` headers, npm tokens and passwords in URLs are masked.
- Credentials are not sent to another host after a redirect, and npm credentials are only sent
  to the registry's own host.
- `strictSSL: false` is possible for broken servers, but shows a warning in the log and the
  tooltip; prefer `ca` with your company's root certificate.

## VS Code and Marketplace terms

Leuchtturm uses only public VS Code APIs. Installs go through VS Code's own
`workbench.extensions.installExtension` command with a local `.vsix`, the same as _Install
from VSIX…_ in the Extensions view. It does not change `product.json` or the Marketplace
configuration, and it does not talk to the Marketplace. It is meant for official VS Code builds
and your own, privately distributed extensions.

## Multiple windows

Only one window checks at a time (a lease in VS Code's global state). Installs of the same
extension are locked across windows, so two windows cannot install it at once.
