# Leuchtturm Updater

A VS Code extension that keeps privately distributed extensions (not on the Microsoft
Marketplace) up to date. It checks configured sources (file share, npm registry,
HTTP/Jenkins with a regex matcher, custom script with a JSON protocol), shows the state in a
sidebar tree and the status bar, notifies the user, and installs through
`workbench.extensions.installExtension`.

**The full specification is in `docs/SPEC.md`. Read it before starting any work.** Implement
the milestones in §12 of the spec in order, and keep each milestone shippable (tests green,
`vsce package` works).

## Ground rules
- Use public VS Code APIs only. Never touch `product.json` or the marketplace configuration.
- TypeScript strict, bundled with esbuild into `dist/extension.js`. Keep runtime dependencies minimal (see SPEC §10). Ask before adding others.
- **Never install automatically.** Checks only notify the user and update the sidebar. Installs start from a user action only, with no setting to change that.
- `script` sources run only if `leuchtturm.script.enabled` is `true` in **user** settings. Read only `inspect().globalValue` (SPEC §6.5).
- The `leuchtturm.sources` setting is `"scope": "machine"`. Never read sources from workspace settings (security, SPEC §9).
- Script sources run through `spawn` with `shell: false` and per-argument templating. No shell strings.
- Redact secrets (`${secret:…}`, auth headers) in every log line.
- Name core types generically (`Artifact`, `Source`) so non-VS-Code targets can be added later.
- Every source type ships with documentation in `docs/sources/` and runnable examples in `examples/`. Python examples use the standard library only (Python ≥ 3.8).
- Write tests alongside features. Use local fixtures (temp dirs, a local HTTP server, fake scripts) and never real company servers.

## Commands (once scaffolded)
- `npm run build`: esbuild bundle
- `npm run watch`: rebuild on change
- `npm test`: unit tests
- `npm run test:integration`: `@vscode/test-electron`
- `npm run lint`
- `npx vsce package`: produce the `.vsix`

## Assets
- `media/icon.svg` / `media/icon.png` (256 px): Marketplace and extension icon
- `media/icon-128.png`: 128 px variant
- `media/activitybar.svg`: monochrome activity bar icon (`currentColor`)

## Owner context
Arne knows Rust well and is newer to the TypeScript and web ecosystem. Briefly explain
TS- or Node-specific idioms in PR descriptions and comments where they aren't obvious.
