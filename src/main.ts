import { debounce, Editor, MarkdownView, moment, normalizePath, Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { addClips, Clip, clipHash, fillDailyTemplate, isClip, isSecretCopy, mergeKlipperHistory, newKlipperItems, noteBaseName, pushClip, SECRET_FORMATS, trimClips } from "./core";
import { ChildProcessLike, KlipperMonitor, loadChildProcess, readKlipperHistory } from "./klipper";
import { DEFAULT_SETTINGS, NotepadSettings, NotepadSettingTab, sanitizeSettings, TAB_IDS, TabId } from "./settings";
import { TimeboxIndex } from "./timebox";
import { NotepadView, VIEW_TYPE } from "./ui/view";

interface StoredData {
  settings: NotepadSettings;
  scratch: string;
  clips: Clip[];
  activeTab: TabId;
  /** Set once the view has been placed in the sidebar the first time. */
  placed: boolean;
  /** `clipHash` of Klipper's newest entry at the last read, to tell what was copied while Obsidian was closed. */
  klipperTop: string;
}

/** How long to wait before trying Klipper again after it wasn't reachable. */
const KLIPPER_RETRY_MS = 60_000;

interface ElectronClipboard {
  readText(): string;
  availableFormats(): string[];
  has(format: string): boolean;
  writeText(text: string): void;
}

interface MomentLike {
  add(amount: number, unit: string): MomentLike;
  format(format: string): string;
}

// obsidian's `moment` export is typed loosely; these are the only calls Notepad needs.
const now = () => (moment as unknown as () => MomentLike)();

interface DailyNotesOptions {
  folder?: string;
  format?: string;
  template?: string;
}

/** Public API for other plugins: `app.plugins.plugins.notepad.api`. */
export interface NotepadApi {
  appendToScratch(text: string): void;
  getScratch(): string;
  getClipboardHistory(): Clip[];
}

export default class NotepadPlugin extends Plugin {
  settings: NotepadSettings = DEFAULT_SETTINGS;
  scratch = "";
  clips: Clip[] = [];
  activeTab: TabId = "notes";
  timeboxIndex!: TimeboxIndex;
  api!: NotepadApi;

  private placed = false;
  private electronClipboard: ElectronClipboard | null = null;
  private lastClipboard = "";
  private watchTimer: number | null = null;
  /** The clipboard settings the watcher was last started with. */
  private watcherKey = "";
  private childProcess: ChildProcessLike | null = null;
  private klipperMonitor: KlipperMonitor | null = null;
  /** Klipper's history at the last read, newest first. */
  private klipperSnapshot: string[] | null = null;
  private klipperTop = "";
  /** Bumped whenever Klipper is started or stopped, so late results of an old start are dropped. */
  private klipperGen = 0;
  private klipperRetry: number | null = null;
  private klipperSyncing = false;
  private klipperSyncAgain = false;
  /** Copies come from Klipper right now. */
  klipperActive = false;
  private saveSoon = debounce(() => void this.persist(), 500, true);

  async onload(): Promise<void> {
    await this.loadState();
    this.timeboxIndex = new TimeboxIndex(this.app);
    this.api = {
      appendToScratch: (text) => this.appendToScratch(text),
      getScratch: () => this.scratch,
      getClipboardHistory: () => this.clips.slice(),
    };

    this.registerView(VIEW_TYPE, (leaf) => new NotepadView(leaf, this));
    this.addSettingTab(new NotepadSettingTab(this.app, this));
    this.addRibbonIcon("notebook-pen", "Open notepad", () => void this.activateView());

    this.addCommand({ id: "open", name: "Open", callback: () => void this.activateView() });
    for (const id of TAB_IDS) {
      this.addCommand({
        id: `show-${id}`,
        name: `Show ${id} tab`,
        callback: () => void this.activateView(id),
      });
    }
    this.addCommand({
      id: "add-selection",
      name: "Add selection to scratch page",
      editorCheckCallback: (checking, editor) => {
        if (!editor.getSelection()) return false;
        if (!checking) this.addSelection(editor);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item
            .setTitle("Add to notepad")
            .setIcon("notebook-pen")
            .onClick(() => this.addSelection(editor))
        );
      })
    );

    // Timebox statistics follow the notes.
    this.registerEvent(this.app.vault.on("modify", (f) => void this.timeboxIndex.onModify(f)));
    this.registerEvent(this.app.vault.on("create", (f) => void this.timeboxIndex.onModify(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.timeboxIndex.onDelete(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => this.timeboxIndex.onRename(f, old)));

    // Copies inside Obsidian are recorded on every platform; the system clipboard is watched on desktop.
    this.registerDomEvent(document, "copy", () => this.recordSelectionCopy());
    this.registerDomEvent(document, "cut", () => this.recordSelectionCopy());
    if (Platform.isDesktopApp) {
      try {
        const req = (window as unknown as { require?: (m: string) => { clipboard?: ElectronClipboard } }).require;
        this.electronClipboard = req?.("electron")?.clipboard ?? null;
        this.lastClipboard = this.electronClipboard?.readText() ?? "";
      } catch (e) {
        console.warn("[notepad] system clipboard is not available", e);
      }
      if (Platform.isLinux) this.childProcess = loadChildProcess();
      // Obsidian doesn't always unload plugins when it quits; don't leave `gdbus monitor` running.
      this.registerDomEvent(window, "beforeunload", () => this.stopKlipper());
    }
    this.restartWatcher();

    this.app.workspace.onLayoutReady(() => {
      if (!this.placed && this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
        void this.activateView(undefined, false).then(() => {
          this.placed = true;
          void this.persist();
        });
      }
    });
  }

  onunload(): void {
    this.stopKlipper();
    this.saveSoon.run();
  }

  // ───────────────────────── state ─────────────────────────

  private async loadState(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Partial<StoredData>;
    this.settings = sanitizeSettings(raw.settings);
    this.scratch = typeof raw.scratch === "string" ? raw.scratch : "";
    this.clips = Array.isArray(raw.clips) ? trimClips(raw.clips.filter(isClip), this.settings.clipboardMax) : [];
    this.activeTab = TAB_IDS.includes(raw.activeTab as TabId) ? (raw.activeTab as TabId) : "notes";
    this.placed = raw.placed === true;
    this.klipperTop = typeof raw.klipperTop === "string" ? raw.klipperTop : "";
  }

  async persist(): Promise<void> {
    const data: StoredData = {
      settings: this.settings,
      scratch: this.scratch,
      clips: this.clips,
      activeTab: this.activeTab,
      placed: this.placed,
      klipperTop: this.klipperTop,
    };
    await this.saveData(data);
  }

  /**
   * Doesn't trim the clipboard history: while the history size is being typed ("2" on the way to
   * "200") that would delete entries. A smaller limit applies from the next copy on.
   */
  async saveSettings(): Promise<void> {
    this.restartWatcher();
    await this.persist();
    this.forEachView((v) => v.refresh());
  }

  /** `from` is the view the user typed in; the other open views are updated. */
  setScratch(text: string, from?: NotepadView): void {
    this.scratch = text;
    this.saveSoon();
    this.forEachView((v) => v !== from && v.syncScratch());
  }

  setActiveTab(tab: TabId): void {
    this.activeTab = tab;
    this.saveSoon();
  }

  private forEachView(fn: (v: NotepadView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof NotepadView) fn(leaf.view);
    }
  }

  // ───────────────────────── view ─────────────────────────

  /** Reveals the notepad (opening it under the Calendar view the first time) and optionally switches tab. */
  async activateView(tab?: TabId, reveal = true): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      const calendar = workspace.getLeavesOfType("calendar")[0];
      leaf = calendar ? workspace.createLeafBySplit(calendar, "horizontal") : workspace.getRightLeaf(true);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (tab) {
      if (!this.settings.tabs[tab]) {
        this.settings.tabs[tab] = true;
        await this.saveSettings();
      }
      this.setActiveTab(tab);
      if (leaf.view instanceof NotepadView) leaf.view.refresh();
    }
    if (reveal) await workspace.revealLeaf(leaf);
  }

  // ───────────────────────── notes ─────────────────────────

  appendToScratch(text: string): void {
    text = text.replace(/\r\n?/g, "\n"); // text copied on Windows; the text box only keeps "\n"
    const sep = this.scratch && !this.scratch.endsWith("\n") ? "\n" : "";
    this.setScratch(this.scratch + sep + text);
  }

  private addSelection(editor: Editor): void {
    this.appendToScratch(editor.getSelection());
    new Notice("Added to notepad.");
  }

  /** Creates a new note from the scratch page. Returns the file, or null if nothing was saved. */
  async saveScratchAsNote(): Promise<TFile | null> {
    const text = this.scratch.trim();
    if (!text) {
      new Notice("The scratch page is empty.");
      return null;
    }
    try {
      const folder = this.settings.saveFolder;
      if (folder) await this.ensureFolder(normalizePath(folder));
      const base = normalizePath(`${folder ? folder + "/" : ""}${noteBaseName(new Date())}`);
      let path = `${base}.md`;
      for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${base} ${i}.md`;
      const file = await this.app.vault.create(path, text + "\n");
      new Notice(`Saved as ${file.basename}.`);
      this.afterSave();
      if (this.settings.openSavedNote) await this.app.workspace.getLeaf("tab").openFile(file);
      return file;
    } catch (e) {
      console.error("[notepad] could not save the note", e);
      new Notice(`Couldn't save the note: ${errorText(e)}`);
      return null;
    }
  }

  /** Creates the folder and any missing parents; fails if a file is in the way. */
  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`"${current}" is a file, not a folder.`);
      await this.app.vault.createFolder(current);
    }
  }

  dailyNotesEnabled(): boolean {
    return this.dailyNotesOptions() !== null;
  }

  private dailyNotesOptions(): DailyNotesOptions | null {
    const internal = (this.app as unknown as {
      internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: { options?: DailyNotesOptions } } | null };
    }).internalPlugins;
    const daily = internal?.getPluginById?.("daily-notes");
    return daily?.enabled ? daily.instance?.options ?? {} : null;
  }

  /** Appends the scratch page to today's daily note (the one the Calendar plugin opens), creating it if needed. */
  async addScratchToDailyNote(): Promise<void> {
    const text = this.scratch.trim();
    if (!text) {
      new Notice("The scratch page is empty.");
      return;
    }
    const opts = this.dailyNotesOptions();
    if (!opts) {
      new Notice("Turn on the daily notes core plugin first.");
      return;
    }
    const folder = (opts.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
    const format = opts.format?.trim() || "YYYY-MM-DD";
    const name = now().format(format);
    const path = normalizePath(`${folder ? folder + "/" : ""}${name}.md`);
    const title = name.slice(name.lastIndexOf("/") + 1); // a format may contain folders, e.g. YYYY/MM/DD

    try {
      let file = this.app.vault.getAbstractFileByPath(path);
      if (file && !(file instanceof TFile)) throw new Error(`"${path}" is a folder.`);
      if (!file) {
        let initial = "";
        const tpl = opts.template?.trim();
        if (tpl) {
          const t = this.app.metadataCache.getFirstLinkpathDest(tpl, "");
          if (t) {
            const raw = await this.app.vault.read(t);
            initial = fillDailyTemplate(raw, title, format, (f, amount = 0, unit = "d") => now().add(amount, unit).format(f));
          } else {
            new Notice(`Daily note template "${tpl}" was not found; the note was created empty.`);
          }
        }
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir) await this.ensureFolder(dir);
        file = await this.app.vault.create(path, initial);
      }
      if (!(file instanceof TFile)) return;
      await this.app.vault.process(file, (old) => {
        const sep = old === "" ? "" : old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n";
        return old + sep + text + "\n";
      });
      new Notice(`Added to ${file.basename}.`);
      this.afterSave();
    } catch (e) {
      console.error("[notepad] could not add to the daily note", e);
      new Notice(`Couldn't add to the daily note: ${errorText(e)}`);
    }
  }

  private afterSave(): void {
    if (this.settings.clearAfterSave) this.setScratch("");
  }

  // ───────────────────────── clipboard ─────────────────────────

  /** Where copies come from right now. */
  get clipboardSource(): "off" | "klipper" | "system" | "obsidian" {
    if (!this.settings.clipboardWatch) return "off";
    if (this.klipperActive) return "klipper";
    return this.electronClipboard ? "system" : "obsidian";
  }

  /** Desktop Linux, where the KDE clipboard history can be read. */
  get klipperSupported(): boolean {
    return this.childProcess !== null;
  }

  /**
   * Picks where copies come from: Klipper on KDE Plasma when it's reachable (it sees every copy),
   * otherwise the system clipboard. Restarts only when a clipboard setting changed.
   */
  private restartWatcher(): void {
    const s = this.settings;
    const key = `${s.clipboardWatch}|${s.klipper}|${s.clipboardInterval}`;
    if (key === this.watcherKey) return;
    this.watcherKey = key;
    this.stopKlipper();
    this.stopPoller();
    if (!s.clipboardWatch) return;
    if (s.klipper && this.childProcess) void this.startKlipper(); // falls back to the poller if unreachable
    else this.startPoller();
  }

  private startPoller(): void {
    if (this.watchTimer !== null || !this.electronClipboard) return;
    try {
      this.lastClipboard = this.electronClipboard.readText(); // what's there now was seen already
    } catch {
      // Read again on the first tick.
    }
    this.watchTimer = this.registerInterval(window.setInterval(() => this.pollClipboard(), this.settings.clipboardInterval));
  }

  private stopPoller(): void {
    if (this.watchTimer !== null) window.clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  private pollClipboard(): void {
    let text: string;
    try {
      text = this.electronClipboard?.readText() ?? "";
    } catch {
      return;
    }
    // Empty: nothing to record, or (on Windows) another app has the clipboard open right now.
    // Keeping the last text means that text isn't recorded again once the read works.
    if (!text || text === this.lastClipboard) return;
    this.lastClipboard = text;
    if (this.electronClipboard && isSecretOnClipboard(this.electronClipboard)) return;
    this.recordClip(text);
  }

  // ───────────────────────── KDE clipboard history ─────────────────────────

  private async startKlipper(): Promise<void> {
    const cp = this.childProcess;
    if (!cp) return;
    const gen = ++this.klipperGen;
    let items: string[];
    try {
      items = await readKlipperHistory(cp);
    } catch {
      if (gen === this.klipperGen) this.klipperUnavailable(gen);
      return;
    }
    if (gen !== this.klipperGen) return;
    this.stopPoller();
    this.applyKlipper(items, true);
    this.klipperMonitor = new KlipperMonitor(
      cp,
      () => void this.syncKlipper(gen),
      () => {
        if (gen === this.klipperGen) this.klipperUnavailable(gen);
      }
    );
    this.setKlipperActive(true);
  }

  /** Falls back to the system clipboard and tries Klipper again later (it may start after Obsidian, or come back after a Plasma restart). */
  private klipperUnavailable(gen: number): void {
    this.klipperMonitor?.stop();
    this.klipperMonitor = null;
    this.klipperSnapshot = null;
    this.setKlipperActive(false);
    this.startPoller();
    this.clearKlipperRetry();
    this.klipperRetry = window.setTimeout(() => {
      this.klipperRetry = null;
      if (gen === this.klipperGen) void this.startKlipper();
    }, KLIPPER_RETRY_MS);
  }

  private stopKlipper(): void {
    this.klipperGen++;
    this.clearKlipperRetry();
    this.klipperMonitor?.stop();
    this.klipperMonitor = null;
    this.klipperSnapshot = null;
    this.setKlipperActive(false);
  }

  private clearKlipperRetry(): void {
    if (this.klipperRetry !== null) window.clearTimeout(this.klipperRetry);
    this.klipperRetry = null;
  }

  /** Reads Klipper again after it signalled a change; one read at a time, repeated if more changes came in. */
  private async syncKlipper(gen: number): Promise<void> {
    const cp = this.childProcess;
    if (!cp) return;
    if (this.klipperSyncing) {
      this.klipperSyncAgain = true;
      return;
    }
    this.klipperSyncing = true;
    try {
      do {
        this.klipperSyncAgain = false;
        const items = await readKlipperHistory(cp);
        if (gen !== this.klipperGen) return;
        this.applyKlipper(items, false);
      } while (this.klipperSyncAgain);
    } catch (e) {
      console.warn("[notepad] couldn't read the KDE clipboard history", e);
    } finally {
      this.klipperSyncing = false;
    }
  }

  /**
   * Brings Klipper's entries into the history. `first`: the first read since Klipper was started.
   * Then only what was copied while Obsidian was closed is added (everything, the very first time);
   * the copy time of those is unknown, so they're marked imported.
   */
  private applyKlipper(items: string[], first: boolean): void {
    const max = this.settings.clipboardMax;
    const at = Date.now();
    let next = this.clips;
    if (!first) {
      next = addClips(next, newKlipperItems(this.klipperSnapshot ?? [], items), at, max, false);
    } else if (!this.klipperTop) {
      next = mergeKlipperHistory(next, items, at, max);
    } else {
      const known = items.findIndex((t) => clipHash(t) === this.klipperTop);
      const fresh = known >= 0 ? items.slice(0, known) : items.filter((t) => !next.some((c) => c.text === t));
      next = addClips(next, fresh.reverse(), at, max, true);
    }
    this.klipperSnapshot = items;
    this.klipperTop = items.length ? clipHash(items[0]) : "";
    if (next !== this.clips) {
      this.clips = next;
      this.forEachView((v) => v.onClipsChanged());
    }
    this.saveSoon();
  }

  private setKlipperActive(active: boolean): void {
    if (this.klipperActive === active) return;
    this.klipperActive = active;
    this.forEachView((v) => v.onClipboardSourceChanged());
  }

  private recordSelectionCopy(): void {
    if (!this.settings.clipboardWatch || this.electronClipboard) return; // the poller sees it on desktop
    // Text fields keep their selection out of the document selection in some browsers.
    const el = activeDocument.activeElement;
    const text =
      el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
        ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
        : activeDocument.getSelection()?.toString() ?? "";
    this.recordClip(text);
  }

  private recordClip(text: string): void {
    const next = pushClip(this.clips, text, Date.now(), this.settings.clipboardMax);
    if (next === this.clips) return;
    this.clips = next;
    this.saveSoon();
    this.forEachView((v) => v.onClipsChanged());
  }

  /** Puts a history entry back on the clipboard (it moves to the top of the list). */
  async copyClip(text: string): Promise<void> {
    try {
      if (this.electronClipboard) {
        this.electronClipboard.writeText(text);
        this.lastClipboard = text;
      } else {
        await navigator.clipboard.writeText(text);
      }
      this.recordClip(text);
      new Notice("Copied.");
    } catch (e) {
      console.error("[notepad] could not copy", e);
      new Notice("Couldn't write to the clipboard.");
    }
  }

  /** Inserts text at the cursor of the most recently used note. */
  async insertIntoNote(text: string): Promise<void> {
    const view = await this.focusNoteForEditing();
    if (!view) {
      new Notice("Open a note first.");
      return;
    }
    view.editor.replaceSelection(text);
  }

  /** A pinned entry that is unpinned counts toward the history size again from the next copy on. */
  togglePin(clip: Clip): void {
    this.clips = this.clips.map((c) => (c === clip ? { ...c, pinned: !c.pinned || undefined } : c));
    this.saveSoon();
    this.forEachView((v) => v.onClipsChanged());
  }

  removeClip(clip: Clip): void {
    this.clips = this.clips.filter((c) => c !== clip);
    this.saveSoon();
    this.forEachView((v) => v.onClipsChanged());
  }

  clearClips(): void {
    this.clips = this.clips.filter((c) => c.pinned);
    this.saveSoon();
    this.forEachView((v) => v.onClipsChanged());
  }

  // ───────────────────────── timebox ─────────────────────────

  /** Starts a session in the last used note with Timebox's own command. */
  async startTimeboxSession(): Promise<void> {
    const view = await this.focusNoteForEditing();
    if (!view) {
      new Notice("Open a note first to start a session.");
      return;
    }
    const commands = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
    if (!commands?.executeCommandById("timebox:start-session")) {
      new Notice("Couldn't start a session. Click in a note and try again.");
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  /** The active note, or the last used one in the main area. */
  private recentMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  /** Focuses the last used note in editing mode (switching from reading view), so text can go in at the cursor. */
  private async focusNoteForEditing(): Promise<MarkdownView | null> {
    const view = this.recentMarkdownView();
    if (!view) return null;
    if (view.getMode() !== "source") await view.setState({ ...view.getState(), mode: "source" }, { history: false });
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    return view;
  }
}

/**
 * Password managers mark copied passwords as secret; such copies are never stored.
 * On Linux the hint shows up in availableFormats(); on Windows and macOS that list only has
 * common types (text, HTML, images), so each hint is also asked for by name.
 */
function isSecretOnClipboard(cb: ElectronClipboard): boolean {
  try {
    if (isSecretCopy(cb.availableFormats())) return true;
  } catch {
    // Formats unavailable: try the named check below.
  }
  for (const format of SECRET_FORMATS) {
    try {
      if (cb.has(format)) return true;
    } catch {
      // Unknown format name on this platform.
    }
  }
  return false;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
