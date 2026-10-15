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

Steps marked 🤖 are also covered by the integration tests; the others need eyes or a click on
a modal dialog.

1. Open the **Leuchtturm** view in the activity bar (lighthouse icon). You should see
   _Updates available (1)_, _Available, not installed (2)_ and _Problems (1)_, a badge `1` on
   the icon and `$(broadcast) 1` on the left of the status bar. 🤖
2. Hover _Leuchtturm Demo Hello_: the tooltip shows the installed and latest version, the
   source, the last check time and the release notes. Click the book icon to open the notes.
3. About 10 seconds after startup a notification says _Leuchtturm Demo Hello 1.1.0 is
   available (installed 1.0.0)_. **Show in Leuchtturm** selects it in the tree.
4. Click the **Skip** icon (⊘) on Hello. It turns grey, and the badge and status bar item
   disappear. Run **Leuchtturm: Reset Skipped Versions** to bring it back. 🤖
5. Click **Update All** (cloud icon in the view title). Only Hello is installed. Click
   **Reload** and the status bar shows `hello 1.1.0`. 🤖
6. Expand _Leuchtturm Demo Hello_ and click the download icon on `1.0.0`. You must confirm
   the downgrade in a modal dialog.
7. Click the download icon on _Leuchtturm Demo Tampered_. It must fail with
   "SHA-256 mismatch". 🤖
8. Run **Leuchtturm: Test Source…** (also in the view's `…` menu) and pick `share`: the log
   lists every matched and skipped file with the reason, and the resulting versions. Try
   `offline` too. 🤖
9. Click the problem node: it opens the log. Debug logging is on.
10. Multi-window: open **File → New Window**. The new window shows the same tree right away
    without checking itself; only one window checks (see "Another window leads update
    checks" in its log). Close the first window: within about three minutes the
    second one takes over.
11. Edit `leuchtturm.sources` in the user settings (for example remove `offline`): the tree
    updates within a second.
