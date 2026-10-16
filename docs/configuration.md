# Configuration

All settings live under `leuchtturm.*`. `leuchtturm.sources` (and `leuchtturm.script.enabled`)
are read from your **user** settings only; values in a workspace's `.vscode/settings.json` are
ignored, so a cloned repository cannot add download locations.

## Settings

| Setting                          | Default       | Description                                                                    |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `leuchtturm.enabled`             | `true`        | Master switch.                                                                 |
| `leuchtturm.checkInterval`       | `60`          | Minutes between checks. `0` disables periodic checks; values below 5 become 5. |
| `leuchtturm.checkOnStartup`      | `true`        | Check about 10 s after VS Code starts.                                         |
| `leuchtturm.notify`              | `true`        | Notify about newly found updates. There is intentionally no auto-install.      |
| `leuchtturm.includePrerelease`   | `false`       | Consider semver prereleases such as `1.2.0-beta.1`.                            |
| `leuchtturm.statusBar`           | `whenUpdates` | `always`, `whenUpdates` or `never`.                                            |
| `leuchtturm.sources`             | `{}`          | Named sources: [`file`](sources/file.md), [`http`](sources/http.md).           |
| `leuchtturm.extensions`          | `[]`          | What to track (see below).                                                     |
| `leuchtturm.trackAllFromSources` | `false`       | Also list extensions that are offered but not installed.                       |
| `leuchtturm.http.timeout`        | `30`          | Default timeout in seconds for listing a source.                               |
| `leuchtturm.script.timeout`      | `120`         | Default script timeout (script sources, coming later).                         |
| `leuchtturm.script.enabled`      | `false`       | Opt-in for script sources (coming later), user settings only.                  |

## Common source fields

| Field                | Description                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `type`               | `file` or `http` (`npm` and `script` follow).                                                                |
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
| `${secret:NAME}`           | Credential stored with **Leuchtturm: Store Credential…**.               |
| `${userHome}`, leading `~` | Home directory.                                                         |
| `${platform}`              | VS Code target platform, e.g. `win32-x64`, `darwin-arm64`, `linux-x64`. |
| `${id}`, `${version}`      | The artifact being downloaded (download URLs, release notes URLs).      |
| `${<group>}`               | A named regex group or JSON field (`http` source).                      |

An unknown or unset variable is a configuration error shown under _Problems_. It is never
replaced with an empty string.

## Secrets

Run **Leuchtturm: Store Credential…**. It lists every `${secret:NAME}` your sources use and
whether a value is stored. The value is kept in VS Code's secret storage (encrypted by the
operating system's keychain), not in `settings.json`. Entering an empty value deletes it.

Stored secrets, `Authorization` headers, npm tokens and passwords in URLs are masked in all
log output.

## Proxies

Leuchtturm has no proxy settings of its own. VS Code routes the network requests of
extensions through its proxy support, so `http`, `npm` and `script` URL downloads follow the
same rules as the rest of VS Code:

- `http.proxy`, or else the system proxy configuration (including PAC files),
- `http.noProxy` for hosts that must be reached directly,
- `http.proxyStrictSSL` for proxies that intercept TLS,
- proxy logins: VS Code asks for credentials when the proxy requires them (or uses Kerberos).
  `http.proxyAuthorization` is **not** applied to extension requests.
- `http.proxySupport` (default `override`) controls all of this; `off` turns it off for
  extensions.

The integration tests send all traffic of the demo scenario through a local proxy and use host
names only that proxy can resolve, so this behaviour is checked on every test run.
