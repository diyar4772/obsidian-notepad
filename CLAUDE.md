# CLAUDE.md: Notepad developer notes

User docs are in `README.md`. Sibling project: Timebox (`../../Timebox/timebox`), same layout and conventions (esbuild + tsc, tiny custom test runner, release on tag push).

## Commands

`npm test && npm run build` must pass after every change. `npm version patch` bumps manifest/versions.

## File map

| File | Responsibility |
| --- | --- |
| `src/core.ts` | Pure logic, must NOT import `obsidian`: clipboard history (`pushClip`, `trimClips`, `isSecretCopy`), time formatting, `readTimeboxSessions` (thin wrapper over Timebox's `findBlocks`), totals (`overlapMs`, `totalsByTopic`), daily note template (`fillDailyTemplate`). |
| `src/timebox-core.ts` | **Verbatim copy of Timebox's `src/core.ts`** (see its header for the version). Notepad uses only `findBlocks` and `parseStamp`, so both plugins agree on what a session block is (fences, callouts, lists, unclosed/invalid blocks). Never edit it here: change Timebox, then copy the file again and update the header. esbuild drops the unused writing code. |
| `src/main.ts` | Plugin: state in data.json (`settings`, `scratch`, `clips`, `activeTab`, `placed`), clipboard watcher, save as note / daily note, commands, public `api`. |
| `src/timebox.ts` | Bridge to the Timebox plugin (`getTimebox`: `active`, `stopSession`) and `TimeboxIndex`, a per-note cache of sessions updated on vault events. |
| `src/ui/view.ts` | `NotepadView` (sidebar `ItemView`): tab bar and the three tabs. |
| `src/settings.ts` | Settings, defaults, `sanitizeSettings`, settings tab. When adding a setting update all three. |
| `test/core.test.ts` | Unit tests for `core.ts` (clipboard history, secret copies, time, the timebox reader incl. callouts and fence rules, template placeholders, linear-time guards). |
| `test/plugin.test.ts`, `test/obsidian-mock.ts` | Integration tests for `main.ts` against a fake `obsidian` (esbuild alias; excluded from `tsc`): data.json recovery, clipboard polling and secret copies, history size not trimmed while typing, save as note (folder chain, name clashes, file in the way), daily note path/template/append, every setting has a declarative control and saving keeps data.json intact, the API, the Timebox bridge and index. A mutation check (re-adding the trim, ignoring secret formats, creating only the last folder) made 4 of them fail. Views and the DOM aren't covered. |

## Invariants

- Timebox owns its blocks; Notepad only reads them, with Timebox's own parser (`timebox-core.ts`). A fuzz comparison of a hand-written reader against Timebox found real divergences (indented fences, extra quote markers inside code blocks), which is why the parser is shared instead of reimplemented. Running sessions come from Timebox's `active` list; an unfinished block not in that list is abandoned and isn't counted.
- Timebox is reached through `app.plugins` at runtime and duck-typed; it may be missing or disabled.
- System clipboard: desktop only, via Electron's `clipboard` polled at `clipboardInterval`. Elsewhere the document `copy`/`cut` events record the selection. Feature-detected, so `isDesktopOnly` stays false.
- No `innerHTML`, no inline styles except CSS variables (`--notepad-accent/bg/text`, `--notepad-font-size`, `--notepad-bar`). Classes prefixed `notepad-`, colors from theme variables.
- Clearing uses a two-click button, never a blocking `confirm()`.
- The view is placed under the Calendar leaf only once (`placed`); afterwards Obsidian's layout restores it.

- Settings are declarative only (`getSettingDefinitions()`, also used by the settings search); there is no `display()` since 1.0.2, because `minAppVersion` is 1.13.0. `getControlValue`/`setControlValue` map `tabs.<id>` keys and save through `plugin.saveSettings()` (the default would overwrite data.json with only the settings and lose the scratch page and clipboard history).
- Clipboard copies marked secret by password managers and copies over `MAX_CLIP_LENGTH` are never stored. `isSecretOnClipboard` checks `availableFormats()` (enough on Linux) **and** `clipboard.has(name)` for each of `SECRET_FORMATS`, because on Windows and macOS `availableFormats()` only lists common types. Empty reads are ignored (on Windows the clipboard can be briefly locked by another app), so the same text isn't recorded twice. Text added to the scratch page gets `\r\n` turned into `\n` (the text box would otherwise differ from the stored text forever).
- Windows-specific behavior is reasoned from Electron/Windows docs and covered by the fake clipboard in the plugin tests, not tried on a Windows machine.
- `minAppVersion` is 1.13.0 (declarative settings without the deprecated `display()` fallback). Users on older Obsidian get 1.0.1 through `versions.json`. Check new APIs against it with Obsidian's lint rules (see "Linting with Obsidian's review rules" in Timebox's CLAUDE.md); it reports nothing today.
- The community review's "Vault Enumeration" and "Clipboard Access" recommendations are disclosures of the Timebox tab's vault scan and the clipboard history. They can't go away without removing those features; the README's "Privacy and permissions" section explains both.

## Known limitations

- **Not covered by tests:** the view (DOM), placement under Calendar, focusing a note in reading view. Check those in a real vault.
- **Wayland:** Electron only sees the clipboard while Obsidian is focused, so copies made elsewhere in the background are missed (only the last one is seen on refocus). Verified on the author's Fedora KDE machine (Obsidian Flatpak, native Wayland). KDE's Klipper history is reachable over D-Bus (`org.kde.klipper /klipper getClipboardHistoryMenu`) but the Flatpak needs `--talk-name=org.kde.klipper`.
- The Timebox tab's day totals in History group a session by its start day; the Today/This week tiles count the part of each session inside the range.

## Possible improvements

- Image entries in the clipboard history; importing KDE Klipper history.
- Multiple scratch pages.

## Changelog

- **1.0.0 (2026-10-26):** First release.
- **1.0.1:** Windows pass: secret hints checked by name (`clipboard.has`), empty reads ignored, CRLF normalized when appending to the scratch page. Second check before publishing: the timebox reader was replaced by Timebox's parser (`timebox-core.ts`); the clipboard history is no longer trimmed while the history size is being typed or when an entry is unpinned; running sessions come from Timebox's active list and the totals update live; Timebox tab redraws keep the scroll position and stop when the view closes; "Start session" and "Insert into note" switch a note in reading view to editing first; daily notes created from a template get their placeholders filled; save errors show a notice; open views share the scratch text. Also addressed the community directory's automated review: `minAppVersion` 1.7.2, declarative settings, no unsafe `moment` call, no promise-returning click handler, sentence case, no deprecated `setDynamicTooltip`. Security pass: secret copies from password managers and very long copies are not recorded; linear-time guard tests for the block reader. Releases get generated notes.
- **1.0.2:** Settings page is declarative only; `minAppVersion` raised to 1.13.0 so the deprecated `display()` fallback could go (the 1.0.1 review's last recommendation in the source code).
