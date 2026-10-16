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
- The `leuchtturm.sources` setting is `"scope": "application"`. Never read sources from workspace settings (security, SPEC §9). Not `machine`: in remote windows VS Code reads machine-scoped settings from the remote side, so Leuchtturm would see no sources.
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
- `npm run test:remote`: the demo scenario in a real Dev Containers window (needs Docker)
- `npm run test:ui`: Playwright clicks through webviews (the source editor) in the test VS Code
- `npm run sandbox`: open a demo VS Code window (isolated profile, demo share); `-- --no-launch` only prepares it, `-- --dev-container` opens it inside a dev container
- `npx vsce package`: produce the `.vsix`

## User-friendly testing (sandbox + scenario)
The owner does not do manual test setups. Every feature that is visible to the user must be
reachable through `npm run sandbox` without any extra steps.
- `src/test/scenario.ts` is the single source of the demo setup (shares, demo VSIX files,
  user settings, workspace). The sandbox and the integration tests both build it, so whatever
  can be tried by hand is also tested automatically.
- When a feature is added (new source type, UI element, setting), extend the scenario with a
  demo case for it: a local fake server or script for `http`/`npm`/`script`, never real servers.
  Add integration tests against it, and add a "Things to try" step to
  `test/fixtures/sandbox-workspace/TRY-ME.md` with the expected result.
- Only steps that automation cannot drive (modal dialogs, visual checks) are left for the
  sandbox alone. Say so in TRY-ME.md.
- Before calling a milestone done, run `npm run sandbox -- --no-launch` to check that the setup builds.
- Webviews (the source editor) are out of reach for the mocha integration tests. Drive them
  with Playwright in `src/test/ui/runUiTest.ts` (`npm run test:ui`): click, type, and check
  the resulting settings.json. On failure it saves a screenshot of the window.
- Remote windows are covered the same way: `src/test/devContainer.ts` opens the scenario in a
  Dev Containers window for both `npm run test:remote` and `npm run sandbox -- --dev-container`.
  Run `npm run test:remote` after changes to settings, installing or extension lookups.

## Assets
- `media/icon.svg` / `media/icon.png` (256 px): Marketplace and extension icon
- `media/icon-128.png`: 128 px variant
- `media/activitybar.svg`: monochrome activity bar icon (`currentColor`)

## Owner context
Arne knows Rust well and is newer to the TypeScript and web ecosystem. Briefly explain
TS- or Node-specific idioms in PR descriptions and comments where they aren't obvious.
