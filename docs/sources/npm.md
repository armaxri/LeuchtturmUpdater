# `npm` source: VSIX files in an npm registry

If your company already runs an npm registry (Nexus, Artifactory, Verdaccio, GitHub Packages,
GitLab), you can distribute extensions through it: each extension version is an npm package
that contains the `.vsix`.

Leuchtturm runs **your own npm** (`npm view`, `npm search`, `npm pack`). Whatever you set up for
npm works here too: the registry for your scope, `npm login`, tokens in `.npmrc`, proxies and
certificates. Leuchtturm itself reads no `.npmrc` and handles no tokens. If `npm view
@corp-vscode/linter` works in a terminal, the source works. npm must be installed (it comes
with Node.js).

**The easy way:** run **Leuchtturm: Add Source…** and enter the package name
(`@corp-vscode/linter`) or the scope (`@corp-vscode`).

The approach is modelled on Garmin's _Private Extension Manager_ (npm packages that carry a
`.vsix`). If you migrate existing packages, check them with **Leuchtturm: Test Source…** first.

```jsonc
// User settings (settings.json)
"leuchtturm.sources": {
  "nexus": {
    "type": "npm",
    "scope": "@corp-vscode"
  }
}
```

with the scope's registry configured for npm, e.g. in `~/.npmrc`:

```ini
@corp-vscode:registry=https://nexus.corp.example/repository/npm-internal/
```

## Options

| Field                                      | Default      | Description                                                                                                                                                                   |
| ------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`                                    |              | List every package of this scope (e.g. `@corp-vscode`) with `npm search`.                                                                                                     |
| `packages`                                 |              | Explicit package names, e.g. `["@corp-vscode/linter"]`. Used instead of `scope` when set. Needed for registries whose search API is missing or limited (some Nexus versions). |
| `registry`                                 | npm's config | Passed to npm as `--registry`. Leave it out to let npm's configuration decide (recommended).                                                                                  |
| `timeout`, `include`, `exclude`, `enabled` |              | As for every source.                                                                                                                                                          |

Either `scope` or `packages` is required. `auth`, `npmrc`, `ca` and `strictSSL` are not
supported: configure npm itself instead, then npm and Leuchtturm both use it.

### Logins

A registry that needs a login works once npm can use it: run `npm login --registry …` (or put
a token into `.npmrc` the way your registry documents it). If npm has no login, _Test Source_
shows npm's own error, e.g. `E401 Unable to authenticate`.

## Package convention

- The package contains **exactly one `.vsix` at its root** (next to `package.json`).
- The extension ID comes from, in this order:
  1. `"vscodeExtension": "corp.linter"` in package.json (recommended),
  2. `"publisher": "corp"` plus the unscoped package name (`@corp-vscode/linter` →
     `corp.linter`), which fits packages that use the extension's own package.json,
  3. the `.vsix` file name in the newest version's tarball (`corp.linter-1.4.1.vsix`).
     This costs one download per package and Leuchtturm session, so prefer option 1.
- `displayName` in package.json is shown in the sidebar.
- All published versions are listed, including deprecated ones; prereleases only with
  `leuchtturm.includePrerelease`.

Installing runs `npm pack <package>@<version>` (npm checks the package's integrity against the
registry), extracts the `.vsix` and installs it.

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

Users only need read access through their own npm login.

## Debugging with Test Source

**Leuchtturm: Test Source…** lists every npm command it ran, the registry npm uses for the scope,
the packages the scope search found, every version with the extension ID it maps to, and
npm's error message for anything that failed.

## Limits

- Proxies and certificates are npm's own settings (`proxy`, `https-proxy`, `cafile` in
  `.npmrc`), not VS Code's.
- The scope search reads at most 2,500 packages.

More snippets: [`examples/settings/npm.jsonc`](../../examples/settings/npm.jsonc).
