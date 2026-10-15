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

| Leuchtturm Demo CI | fake **Jenkins** (`jenkins` source, needs a password): 2.0.0, 2.1.0 | 2.0.0 | Appears once the credential is stored. Update to 2.1.0. |
| Leuchtturm Demo Web | fake **web server listing** over HTTPS (`web` source, custom CA): 0.3.0 | no | Can be installed. |
| Leuchtturm Demo Registry | fake **npm registry** (`npm` source, token from `.sandbox/npmrc`): 3.0.0, 3.1.0 | 3.0.0 | Update to 3.1.0. |
| Leuchtturm Demo Packed | fake **npm registry**, package without `vscodeExtension`: 0.9.0 | no | ID read from the `.vsix` inside. Can be installed. |

The user settings also contain a source called `offline` that points to a folder that does
not exist, so a problem shows up.

The fake Jenkins, web server and npm registry run inside the `npm run sandbox` process. Keep it running;
Ctrl+C stops them (the `jenkins`, `web` and `npm` sources then show up as problems).

The demo extensions show their version in the status bar (bottom right, `$(beaker) hello 1.0.0`).

## Things to try

Steps marked 🤖 are also covered by the integration tests; the others need eyes or a click on
a modal dialog.

1. Open the **Leuchtturm** view in the activity bar (lighthouse icon). You should see
   _Updates available (2)_, _Available, not installed (4)_ and _Problems (2)_, a badge `2` on
   the icon and `$(broadcast) 2` on the left of the status bar. 🤖 One problem says
   _Secret "jenkins-demo" is not stored_.
2. Run **Leuchtturm: Store Credential…** (also in the view's `…` menu), pick `jenkins-demo`
   and enter `demo-password`. _Leuchtturm Demo CI 2.0.0 → 2.1.0_ appears under updates and
   the badge shows `3`. 🤖 Click the book icon on it: the release notes are fetched from
   Jenkins with your credential. 🤖
3. Hover _Leuchtturm Demo Hello_: the tooltip shows the installed and latest version, the
   source, the last check time and the release notes. Click the book icon to open the notes.
4. About 10 seconds after startup a notification says _Leuchtturm Demo Hello 1.1.0 is
   available (installed 1.0.0)_. **Show in Leuchtturm** selects it in the tree.
5. Click the **Skip** icon (⊘) on Hello. It turns grey and is no longer counted in the badge.
   Run **Leuchtturm: Reset Skipped Versions** to bring it back. 🤖
6. Click **Update All** (cloud icon in the view title). Hello, CI and Registry are installed,
   nothing else. Click **Reload**; the status bar shows `hello 1.1.0`, `ci 2.1.0` and
   `registry 3.1.0`. 🤖
7. Expand _Leuchtturm Demo Hello_ and click the download icon on `1.0.0`. You must confirm
   the downgrade in a modal dialog.
8. Click the download icon on _Leuchtturm Demo Tampered_. It must fail with
   "SHA-256 mismatch". 🤖
9. Click the download icon on _Leuchtturm Demo Web_: it is downloaded over HTTPS from a
   server with a self-signed certificate, trusted through the `ca` setting. 🤖 Then install
   _Leuchtturm Demo Packed_: the tarball's integrity is checked and the `.vsix` extracted. 🤖
10. Run **Leuchtturm: Test Source…** (also in the view's `…` menu) and pick `share`: the log
    lists every matched and skipped file with the reason, and the resulting versions. Try
    `jenkins` (HTTP status, start of the JSON body, every match and its download URL), `npm`
    (scope search, version → ID mapping, tarball URLs) and `offline` too. 🤖 Passwords and
    tokens never appear in the log.
11. Click a problem node: it opens the log. Debug logging is on.
12. Multi-window: open **File → New Window**. The new window shows the same tree right away
    without checking itself; only one window checks (see "Another window leads update
    checks" in its log). Close the first window: within about three minutes the second one
    takes over.
13. Edit `leuchtturm.sources` in the user settings (for example remove `offline`): the tree
    updates within a second.
14. Stop `npm run sandbox` with Ctrl+C and run **Leuchtturm: Check for Updates**: the
    `jenkins`, `web` and `npm` sources show up as problems, the share keeps working.
