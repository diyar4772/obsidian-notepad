import { debounce, Editor, MarkdownView, moment, normalizePath, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { Clip, isClip, isSecretCopy, noteBaseName, pushClip, trimClips } from "./core";
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
}

interface ElectronClipboard {
  readText(): string;
  availableFormats(): string[];
  writeText(text: string): void;
}

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
  }

  async persist(): Promise<void> {
    const data: StoredData = {
      settings: this.settings,
      scratch: this.scratch,
      clips: this.clips,
      activeTab: this.activeTab,
      placed: this.placed,
    };
    await this.saveData(data);
  }

  async saveSettings(): Promise<void> {
    this.clips = trimClips(this.clips, this.settings.clipboardMax);
    this.restartWatcher();
    await this.persist();
    this.forEachView((v) => v.refresh());
  }

  setScratch(text: string): void {
    this.scratch = text;
    this.saveSoon();
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
    const sep = this.scratch && !this.scratch.endsWith("\n") ? "\n" : "";
    this.setScratch(this.scratch + sep + text);
    this.forEachView((v) => v.refresh());
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
    const folder = this.settings.saveFolder;
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const base = normalizePath(`${folder ? folder + "/" : ""}${noteBaseName(new Date())}`);
    let path = `${base}.md`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${base} ${i}.md`;
    const file = await this.app.vault.create(path, text + "\n");
    new Notice(`Saved as ${file.basename}.`);
    if (this.settings.openSavedNote) await this.app.workspace.getLeaf("tab").openFile(file);
    this.afterSave();
    return file;
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
    // obsidian's `moment` export is typed loosely; this is the only call we need.
    const now = (moment as unknown as () => { format(f: string): string })();
    const name = now.format(opts.format?.trim() || "YYYY-MM-DD");
    const path = normalizePath(`${folder ? folder + "/" : ""}${name}.md`);

    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      let initial = "";
      const tpl = opts.template?.trim();
      if (tpl) {
        const t = this.app.metadataCache.getFirstLinkpathDest(tpl, "");
        if (t) initial = await this.app.vault.read(t);
      }
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      file = await this.app.vault.create(path, initial);
    }
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, (old) => {
      const sep = old === "" ? "" : old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n";
      return old + sep + text + "\n";
    });
    new Notice(`Added to ${file.basename}.`);
    this.afterSave();
  }

  private afterSave(): void {
    if (!this.settings.clearAfterSave) return;
    this.setScratch("");
    this.forEachView((v) => v.refresh());
  }

  // ───────────────────────── clipboard ─────────────────────────

  get systemClipboardAvailable(): boolean {
    return this.electronClipboard !== null;
  }

  private restartWatcher(): void {
    if (this.watchTimer !== null) window.clearInterval(this.watchTimer);
    this.watchTimer = null;
    if (!this.settings.clipboardWatch || !this.electronClipboard) return;
    this.watchTimer = this.registerInterval(window.setInterval(() => this.pollClipboard(), this.settings.clipboardInterval));
  }

  private pollClipboard(): void {
    let text: string;
    try {
      text = this.electronClipboard?.readText() ?? "";
    } catch {
      return;
    }
    if (text === this.lastClipboard) return;
    this.lastClipboard = text;
    // Password managers mark copied passwords as secret; never store those.
    try {
      if (isSecretCopy(this.electronClipboard?.availableFormats() ?? [])) return;
    } catch {
      // Formats unavailable: record as usual.
    }
    this.recordClip(text);
  }

  private recordSelectionCopy(): void {
    if (!this.settings.clipboardWatch || this.electronClipboard) return; // the poller sees it on desktop
    const text = activeDocument.getSelection()?.toString() ?? "";
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
  insertIntoNote(text: string): void {
    const view = this.recentMarkdownView();
    if (!view) {
      new Notice("Open a note first.");
      return;
    }
    view.editor.replaceSelection(text);
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
  }

  togglePin(clip: Clip): void {
    this.clips = trimClips(
      this.clips.map((c) => (c === clip ? { ...c, pinned: !c.pinned || undefined } : c)),
      this.settings.clipboardMax
    );
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

  // ───────────────────────── helpers ─────────────────────────

  recentMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }
}
