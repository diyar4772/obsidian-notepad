# CLAUDE.md: Notepad developer notes

User docs are in `README.md`. Sibling project: Timebox (`../../Timebox/timebox`), same layout and conventions (esbuild + tsc, tiny custom test runner, release on tag push).

## Commands

`npm test && npm run build` must pass after every change. `npm version patch` bumps manifest/versions.

## File map

| File | Responsibility |
| --- | --- |
| `src/core.ts` | Pure logic, must NOT import `obsidian`: clipboard history (`pushClip`, `trimClips`), time formatting/parsing (Timebox formats), read-only `timebox` block reader (`readTimeboxSessions`), totals (`overlapMs`, `totalsByTopic`). |
| `src/main.ts` | Plugin: state in data.json (`settings`, `scratch`, `clips`, `activeTab`, `placed`), clipboard watcher, save as note / daily note, commands, public `api`. |
| `src/timebox.ts` | Bridge to the Timebox plugin (`getTimebox`: `active`, `stopSession`) and `TimeboxIndex`, a per-note cache of sessions updated on vault events. |
| `src/ui/view.ts` | `NotepadView` (sidebar `ItemView`): tab bar and the three tabs. |
| `src/settings.ts` | Settings, defaults, `sanitizeSettings`, settings tab. When adding a setting update all three. |

## Invariants

- Timebox owns its blocks; Notepad only reads them. Running sessions come from Timebox's `active` list; an unfinished block not in that list is abandoned and isn't counted.
- Timebox is reached through `app.plugins` at runtime and duck-typed; it may be missing or disabled.
- System clipboard: desktop only, via Electron's `clipboard` polled at `clipboardInterval`. Elsewhere the document `copy`/`cut` events record the selection. Feature-detected, so `isDesktopOnly` stays false.
- No `innerHTML`, no inline styles except CSS variables (`--notepad-accent/bg/text`, `--notepad-font-size`, `--notepad-bar`). Classes prefixed `notepad-`, colors from theme variables.
- Clearing uses a two-click button, never a blocking `confirm()`.
- The view is placed under the Calendar leaf only once (`placed`); afterwards Obsidian's layout restores it.

- Settings have two paths, as in Timebox 1.0.1: `getSettingDefinitions()` (1.13+, also used by settings search) and `display()` (older versions). **Keep both in sync.** `getControlValue`/`setControlValue` map `tabs.<id>` keys and save through `plugin.saveSettings()` (the default would overwrite data.json with only the settings and lose the scratch page and clipboard history).
- Clipboard copies marked secret by password managers (`isSecretCopy`) and copies over `MAX_CLIP_LENGTH` are never stored.
- `minAppVersion` is 1.7.2 (awaited `revealLeaf`). Check new APIs against it with Obsidian's lint rules: see "Linting with Obsidian's review rules" in Timebox's CLAUDE.md. Only the intentional `display` deprecation warning should remain.

## Possible improvements

- Image entries in the clipboard history; importing KDE Klipper history.
- Multiple scratch pages.

## Changelog

- **1.0.0 (2026-10-26):** First release.
- **1.0.1:** Addressed the community directory's automated review: `minAppVersion` 1.7.2, declarative settings, no unsafe `moment` call, no promise-returning click handler, sentence case, no deprecated `setDynamicTooltip`. Security pass: secret copies from password managers and very long copies are not recorded; linear-time guard tests for the block reader. Releases get generated notes.
