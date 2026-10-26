# Notepad

A tabbed panel for Obsidian's sidebar. Pick a tab at the top:

- **Notes**: a scratch page for quick thoughts while you work on something else. It saves itself as you type. You can turn it into a note, add it to today's daily note (the one the Calendar plugin opens) or copy it.
- **Clipboard**: a history of the text you copy. On desktop it records copies from any app while Obsidian is running (see [Linux with Wayland](#linux-with-wayland) for a limit there). On mobile it records copies made inside Obsidian. Click an entry to copy it again, insert it into the open note, add it to the scratch page, pin it or remove it. Search included.
- **Timebox**: works with the [Timebox](#timebox) plugin. It shows running sessions with a live timer and a finish button, today's and this week's totals, this week's time per topic, and finished sessions grouped by day. Click a session to jump to its note.

On first start the panel opens under the Calendar view in the right sidebar, or in a new split in the right sidebar if Calendar isn't installed. You can drag it anywhere.

### Linux with Wayland

On a Wayland session (the default on Fedora, recent KDE Plasma and GNOME), Obsidian only sees the clipboard while its window is focused. Copies you make in other apps while Obsidian is in the background aren't seen one by one; when you switch back, only the last one is recorded. Copies made inside Obsidian are always recorded. Windows, macOS and Linux on X11 don't have this limit.

## Settings

- Show or hide each tab.
- Notes: save folder, open the note after saving, clear after saving, font size.
- Clipboard: turn recording on/off, history size (pinned entries don't count), check interval.
- Timebox: how many days of history to list.
- Colors: accent, background and text color. Reset any of them to follow your theme.

## Commands

- Open
- Show notes / clipboard / timebox tab
- Add selection to scratch page (also in the editor's right-click menu as "Add to notepad")

## Timebox

[Timebox](https://github.com/diyar4772/obsidian-timebox) is a companion plugin by the same author. It tracks study and work sessions inside your notes: you start a session, a `timebox` block with the topic and start time goes into the note, and when you finish, the end time and duration are written into it. It has an optional pomodoro cycle with alerts and shows the running session in the status bar.

Notepad's Timebox tab gives those sessions a home in the sidebar:

- **Running sessions** with a live timer, the note they belong to and a finish button. Finishing goes through Timebox, so the block in your note is updated exactly as if you had clicked Finish in the note.
- **Start session** focuses your last note and runs Timebox's own *Start session* command.
- **Today** and **this week** totals.
- **This week by topic**: time per topic as bars.
- **History**: finished sessions of the last days (7 by default), grouped by day with daily totals. Click one to jump to its block.

Notepad finds sessions by reading the `timebox` blocks in your notes and updates as you edit them. It never writes to them. Unfinished blocks that Timebox isn't running (for example one left open by hand) aren't counted. Without Timebox installed and enabled, the tab says so; the other tabs work on their own.

## Working with other plugins

- **Timebox**: see above.
- **Calendar / Daily notes**: "Add to today's daily note" uses the folder, date format and template from the Daily notes core plugin, so it lands in the same note Calendar opens. When the note doesn't exist yet it is created from your template, with `{{date}}`, `{{time}}`, `{{title}}`, `{{yesterday}}`, `{{tomorrow}}` and `{{date:FORMAT}}` filled in like the core plugin does.
- **API for other plugins**: `app.plugins.plugins.notepad.api` provides `appendToScratch(text)`, `getScratch()` and `getClipboardHistory()`.

## Privacy and permissions

Notepad makes no network requests. Everything stays in the plugin's `data.json` inside your vault (`.obsidian/plugins/notepad/`).

- **Clipboard:** on desktop Notepad reads the system clipboard to build the history, and writes to it when you copy an entry back. Copies that a password manager marks as secret (KeePassXC, Bitwarden, 1Password and others that use the standard hint on Linux, macOS or Windows) are not recorded. Copies longer than 100,000 characters are skipped. The history is stored as plain text, so if your vault is synced, it travels with it. Turn recording off or clear the history if that matters to you.
- **Reading the vault:** to find Timebox sessions, the Timebox tab reads your notes once, the first time you open it, then only re-reads notes that change. Nothing is collected or written by this.
- **Writing:** Notepad only creates or changes notes when you ask it to (save as note, add to daily note, insert into note).

## Development

```bash
npm install
npm run dev    # watch build
npm test       # core and plugin tests
npm run build  # type check + production build
```

## License

MIT
