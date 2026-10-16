# `npm` source: VSIX files in an npm registry

If your company already runs an npm registry (Nexus, Artifactory, Verdaccio, GitHub Packages,
GitLab), you can distribute extensions through it: each extension version is an npm package
that contains the `.vsix`. Leuchtturm reads the registry's HTTP API directly; the npm CLI is
only needed for publishing.

The approach is modelled on Garmin's _Private Extension Manager_ (npm packages that carry a
`.vsix`). If you migrate existing packages, check them with **Leuchtturm: Test Source…** first.

```jsonc
// User settings (settings.json)
"leuchtturm.sources": {
  "nexus": {
    "type": "npm",
    "registry": "https://nexus.corp.example/repository/npm-internal/",
    "scope": "@corp-vscode"
  }
}
```

## Options

| Field                                      | Default       | Description                                                                                                                                                                   |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry`                                 | (required)    | Registry URL.                                                                                                                                                                 |
| `scope`                                    |               | List every package of this scope (e.g. `@corp-vscode`) via the registry's search API.                                                                                         |
| `packages`                                 |               | Explicit package names, e.g. `["@corp-vscode/linter"]`. Used instead of `scope` when set. Needed for registries whose search API is missing or limited (some Nexus versions). |
| `auth`                                     | from `.npmrc` | `{ "token": "${secret:nexus-token}" }`, `{ "bearer": "…" }` or `{ "basic": { "user", "password" } }`.                                                                         |
| `npmrc`                                    | `~/.npmrc`    | The `.npmrc` to read credentials from when `auth` is not set.                                                                                                                 |
| `ca`, `strictSSL`                          |               | As for the [`http` source](http.md#options).                                                                                                                                  |
| `timeout`, `include`, `exclude`, `enabled` |               | As for every source.                                                                                                                                                          |

Either `scope` or `packages` is required.

### Credentials

Without `auth`, Leuchtturm reads the same `.npmrc` entries as the npm CLI and picks the most
specific one for the registry URL:

```ini
//nexus.corp.example/repository/npm-internal/:_authToken=${NPM_TOKEN}
//nexus.corp.example/:_auth=dXNlcjpwYXNzd29yZA==
//nexus.corp.example/:username=ci-reader
//nexus.corp.example/:_password=cGFzc3dvcmQ=
```

`${VAR}` in `.npmrc` values is taken from the environment, as npm does. Tokens are masked in
the log. Credentials are only sent to the registry's own host: a tarball served from another
host (a CDN) is fetched without them.

## Package convention

- The package contains **exactly one `.vsix` at its root** (next to `package.json`).
- The extension ID comes from, in this order:
  1. `"vscodeExtension": "corp.linter"` in package.json (recommended),
  2. `"publisher": "corp"` plus the unscoped package name (`@corp-vscode/linter` →
     `corp.linter`), which fits packages that use the extension's own package.json,
  3. the `.vsix` file name in the newest version's tarball (`corp.linter-1.4.1.vsix`).
     This costs one download per package and Leuchtturm session, so prefer option 1.
- `displayName` in package.json is shown in the sidebar.
- Deprecated versions (`npm deprecate`) are hidden.

Installing downloads the tarball, verifies `dist.integrity` (or the older `dist.shasum`)
against the registry, extracts the `.vsix` and installs it.

## Publishing

### 1. Build the VSIX

```sh
npx @vscode/vsce package          # → corp.linter-1.4.1.vsix
```

### 2. Wrap it in an npm package

The minimal package.json ([`examples/npm/package.json`](../../examples/npm/package.json)):

```json
{
  "name": "@corp-vscode/linter",
  "version": "1.4.1",
  "vscodeExtension": "corp.linter",
  "displayName": "Corp Linter",
  "files": ["*.vsix"]
}
```

Keep `version` equal to the extension's version.

### 3. Publish

```sh
npm publish --registry https://nexus.corp.example/repository/npm-internal/
```

[`examples/npm/publish.sh`](../../examples/npm/publish.sh) does steps 2 and 3 for any `.vsix`:
it reads the ID and version from the file name, writes the package.json in a temporary
folder and publishes it.

```sh
PACKAGE_SCOPE=@corp-vscode ./publish.sh corp.linter-1.4.1.vsix https://nexus.corp.example/repository/npm-internal/
PACK_ONLY=1 ./publish.sh corp.linter-1.4.1.vsix   # just build the .tgz to inspect it
```

### In CI

Store a publish token as a CI secret and give npm an `.npmrc` that reads it:

```yaml
# GitHub Actions example
- run: npx @vscode/vsce package
- run: echo "//nexus.corp.example/repository/npm-internal/:_authToken=\${NPM_TOKEN}" > .npmrc-publish
- run: ./examples/npm/publish.sh *.vsix https://nexus.corp.example/repository/npm-internal/
  env:
    NPM_TOKEN: ${{ secrets.NEXUS_PUBLISH_TOKEN }}
    NPM_CONFIG_USERCONFIG: .npmrc-publish
```

Users only need read access; give Leuchtturm a read-only token.

## Debugging with Test Source

**Leuchtturm: Test Source…** lists the registry requests with their status, the packages the
scope search found, every version with the extension ID it maps to and its tarball URL, and
every version that was skipped (not semver, deprecated, no tarball) or failed.

## Limits

- Proxies are handled by VS Code, see [Proxies](../configuration.md#proxies).
- The scope search reads at most 2,500 packages.

More snippets: [`examples/settings/npm.jsonc`](../../examples/settings/npm.jsonc).
