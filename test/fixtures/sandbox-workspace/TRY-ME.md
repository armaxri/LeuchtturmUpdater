# Leuchtturm sandbox

This window runs the **development build** of Leuchtturm Updater in an isolated profile.
Your normal VS Code settings and extensions are not touched. Everything lives in `.sandbox/`
inside the repository and is rebuilt on every `npm run sandbox`.

## What is prepared

| Extension                | On the share                                                         | Installed | Expected                                                         |
| ------------------------ | -------------------------------------------------------------------- | --------- | ---------------------------------------------------------------- |
| Leuchtturm Demo Hello    | 1.0.0, 1.1.0 (with SHA-256 + notes), 1.2.0-beta.1                    | 1.0.0     | Update to 1.1.0. The beta stays hidden.                          |
| Leuchtturm Demo World    | 0.5.0 (publisher folder)                                             | no        | Can be installed through _Install Specific Version…_.            |
| Leuchtturm Demo Tampered | 1.0.0 with a wrong `.sha256`                                         | no        | Installing fails with "SHA-256 mismatch".                        |
| Leuchtturm Demo Evil     | only in an "evil" source in this workspace's `.vscode/settings.json` | no        | Must never appear, because sources come from user settings only. |

The user settings also contain a source called `offline` that points to a folder that does
not exist, so a problem shows up.

The demo extensions show their version in the status bar (bottom right, `$(beaker) hello 1.0.0`).

## Things to try

1. Wait about 10 seconds after startup: a notification says _Leuchtturm Demo Hello 1.1.0 is
   available (installed 1.0.0)_.
2. Click **Show Updates**, keep the selection and press Enter. After installing, click
   **Reload**. The status bar should now show `hello 1.1.0`.
3. Run **Leuchtturm: Check for Updates** (Command Palette). With everything up to date you
   get a warning that the `offline` source has a problem.
4. Run **Leuchtturm: Install Specific Version…** → _Leuchtturm Demo Hello_ → `1.0.0`. You
   must confirm the downgrade in a modal dialog.
5. Run **Leuchtturm: Install Specific Version…** → _Leuchtturm Demo Tampered_. It must fail.
6. Run **Leuchtturm: Show Log** to see what happened. Debug logging is on.
7. Try _Skip This Version_ on a notification, then **Leuchtturm: Reset Skipped Versions**.
