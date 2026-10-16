# Configuration

All settings live under `leuchtturm.*`. `leuchtturm.sources` (and `leuchtturm.script.enabled`)
are read from your **user** settings only; values in a workspace's `.vscode/settings.json` are
ignored, so a cloned repository cannot add download locations.

VS Code's Settings page cannot show input fields for nested objects such as
`leuchtturm.sources`. Use **Leuchtturm: Add Source…** instead (also the **+** button in the
Leuchtturm view and the link on the Settings page): paste the link where you download the
extension (a Jenkins job, a web page with `.vsix` links, a folder, an npm package name), check
what Leuchtturm found, and save. **Leuchtturm: Manage Sources** and _Edit Source_ on a problem
or extension in the view open a detailed form for each source, which checks the fields with the
same rules as the checks themselves and runs _Test Source_ on the unsaved form. Fields the form
does not know are kept as they are. Saving rewrites the `leuchtturm.sources` entry in your
settings.json, so comments inside that entry are lost.

## Settings

| Setting                          | Default       | Description                                                                                                                  |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `leuchtturm.enabled`             | `true`        | Master switch.                                                                                                               |
| `leuchtturm.checkInterval`       | `60`          | Minutes between checks. `0` disables periodic checks; values below 5 become 5.                                               |
| `leuchtturm.checkOnStartup`      | `true`        | Check about 10 s after VS Code starts.                                                                                       |
| `leuchtturm.notify`              | `true`        | Notify about newly found updates. There is intentionally no auto-install.                                                    |
| `leuchtturm.includePrerelease`   | `false`       | Consider semver prereleases such as `1.2.0-beta.1`.                                                                          |
| `leuchtturm.statusBar`           | `whenUpdates` | `always`, `whenUpdates` or `never`.                                                                                          |
| `leuchtturm.sources`             | `{}`          | Named sources: [`file`](sources/file.md), [`http`](sources/http.md), [`npm`](sources/npm.md), [`script`](sources/script.md). |
| `leuchtturm.extensions`          | `[]`          | What to track (see below).                                                                                                   |
| `leuchtturm.trackAllFromSources` | `false`       | Also list extensions that are offered but not installed.                                                                     |
| `leuchtturm.http.timeout`        | `30`          | Default timeout in seconds for listing a source.                                                                             |
| `leuchtturm.script.timeout`      | `120`         | Default timeout in seconds for one script run.                                                                               |
| `leuchtturm.script.enabled`      | `false`       | Opt-in for script sources, user settings only.                                                                               |

## Common source fields

| Field                | Description                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `type`               | `file`, `http`, `npm` or `script`.                                                                           |
| `enabled`            | `false` switches the source off.                                                                             |
| `timeout`            | Seconds for listing the source.                                                                              |
| `include`, `exclude` | Glob filters on extension IDs, e.g. `["corp.*"]`. `*` matches anything, `?` one character, case-insensitive. |

## Tracking (`leuchtturm.extensions`)

```jsonc
"leuchtturm.extensions": [
  "corp.linter",                                             // from any source
  "share:corp.snippets",                                     // only from the source "share"
  { "id": "corp.theme", "source": "nexus", "pin": "2.1.x" }, // semver range
  { "id": "corp.legacy", "enabled": false }
]
```

With an empty list, every installed extension that a source offers is tracked. When several
sources offer the same extension, the highest version wins; for equal versions the source
listed first in `leuchtturm.sources` wins. `pin` accepts npm-style ranges: `2.1.x`, `^1.4`,
`~1.4.2`, `>=1.0 <2`, `1.0 - 1.4`, `^1 || ^3`.

## Variables

Strings in source settings may contain variables:

| Variable                   | Meaning                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `${env:NAME}`              | Environment variable.                                                   |
| `${userHome}`, leading `~` | Home directory.                                                         |
| `${platform}`              | VS Code target platform, e.g. `win32-x64`, `darwin-arm64`, `linux-x64`. |
| `${id}`, `${version}`      | The artifact being downloaded (download URLs, release notes URLs).      |
| `${<group>}`               | A named regex group or JSON field (`http` source).                      |

An unknown or unset variable is a configuration error shown under _Problems_. It is never
replaced with an empty string.

## Logins and certificates

Leuchtturm handles no credentials: no passwords, tokens or login headers in its settings, and
no secret storage. `http` sources are for servers that need no login; for one that does, use a
[`script` source](sources/script.md), which signs in itself. `npm` sources run your own npm, so
logins set up for npm (`npm login`, `.npmrc`) are used by npm, not by Leuchtturm.

There are no certificate settings either. HTTPS uses the certificates VS Code trusts, which
include those installed on your computer, so an internal company CA installed by your IT works.

Log output still masks `Authorization` headers and passwords in URLs, in case a script or
server prints them.

## Proxies

Leuchtturm has no proxy settings of its own. VS Code routes the network requests of
extensions through its proxy support, so `http` sources and `script` URL downloads follow the
same rules as the rest of VS Code (`npm` sources use npm's own `proxy` settings):

- `http.proxy`, or else the system proxy configuration (including PAC files),
- `http.noProxy` for hosts that must be reached directly,
- `http.proxyStrictSSL` for proxies that intercept TLS,
- proxy logins: VS Code asks for credentials when the proxy requires them (or uses Kerberos).
  `http.proxyAuthorization` is **not** applied to extension requests.
- `http.proxySupport` (default `override`) controls all of this; `off` turns it off for
  extensions.

The integration tests send all traffic of the demo scenario through a local proxy and use host
names only that proxy can resolve, so this behaviour is checked on every test run.
