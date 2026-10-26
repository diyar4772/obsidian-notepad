import { debounce, ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { dayKey, formatClock, formatDuration, formatTimer, overlapMs, parseTime, startOfDay, startOfWeek, totalsByTopic } from "../core";
import type NotepadPlugin from "../main";
import { TAB_IDS, TAB_LABELS, TabId } from "../settings";
import { getTimebox, IndexedSession } from "../timebox";

export const VIEW_TYPE = "notepad-view";

const TAB_ICONS: Record<TabId, string> = {
  notes: "pencil",
  clipboard: "clipboard-list",
  timebox: "timer",
};

export class NotepadView extends ItemView {
  private tabBar!: HTMLElement;
  private body!: HTMLElement;
  private shown: TabId | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private clipList: HTMLElement | null = null;
  private clipQuery = "";
  private timer: number | null = null;
  private renderTimeboxSoon = debounce(() => this.shown === "timebox" && void this.renderTimebox(), 300, true);

  constructor(leaf: WorkspaceLeaf, private plugin: NotepadPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Notepad";
  }

  getIcon(): string {
    return "notebook-pen";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("notepad-view");
    this.tabBar = this.contentEl.createDiv({ cls: "notepad-tabs" });
    this.body = this.contentEl.createDiv({ cls: "notepad-body" });
    this.registerEvent(this.plugin.timeboxIndex.on("changed", () => this.renderTimeboxSoon()));
    this.refresh();
  }

  async onClose(): Promise<void> {
    this.stopTimer();
  }

  /** Re-applies settings and redraws the tab bar; the current tab is redrawn only if it changed. */
  refresh(): void {
    if (!this.body) return;
    this.applyColors();
    const tabs = TAB_IDS.filter((t) => this.plugin.settings.tabs[t]);
    let current = this.plugin.activeTab;
    if (!tabs.includes(current)) current = tabs[0] ?? "notes";

    this.tabBar.empty();
    this.tabBar.toggleClass("is-hidden", tabs.length <= 1);
    for (const id of tabs) {
      const btn = this.tabBar.createEl("button", { cls: "notepad-tab", attr: { "aria-label": TAB_LABELS[id] } });
      setIcon(btn.createSpan({ cls: "notepad-tab-icon" }), TAB_ICONS[id]);
      btn.createSpan({ cls: "notepad-tab-label", text: TAB_LABELS[id] });
      btn.toggleClass("is-active", id === current);
      btn.addEventListener("click", () => {
        this.plugin.setActiveTab(id);
        this.refresh();
      });
    }

    if (tabs.length === 0) {
      this.show(null);
      this.body.createDiv({ cls: "notepad-empty", text: "All tabs are turned off. Turn one on in the settings." });
      return;
    }
    if (current !== this.shown) this.show(current);
    else if (current === "notes" && this.textarea) {
      if (this.textarea.value !== this.plugin.scratch) this.textarea.value = this.plugin.scratch;
      this.textarea.style.setProperty("--notepad-font-size", `${this.plugin.settings.fontSize}px`);
      this.updateCount();
    } else if (current === "clipboard") this.renderClipList();
    else if (current === "timebox") void this.renderTimebox();
  }

  onClipsChanged(): void {
    if (this.shown === "clipboard") this.renderClipList();
  }

  private applyColors(): void {
    const s = this.plugin.settings;
    const set = (name: string, v: string) => (v ? this.contentEl.style.setProperty(name, v) : this.contentEl.style.removeProperty(name));
    set("--notepad-accent", s.accentColor);
    set("--notepad-bg", s.backgroundColor);
    set("--notepad-text", s.textColor);
  }

  private show(tab: TabId | null): void {
    this.stopTimer();
    this.textarea = null;
    this.clipList = null;
    this.body.empty();
    this.shown = tab;
    if (tab === "notes") this.renderNotes();
    else if (tab === "clipboard") this.renderClipboard();
    else if (tab === "timebox") void this.renderTimebox();
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  // ───────────────────────── notes ─────────────────────────

  private renderNotes(): void {
    const bar = this.body.createDiv({ cls: "notepad-toolbar" });
    this.textarea = this.body.createEl("textarea", {
      cls: "notepad-scratch",
      attr: { placeholder: "Jot something down…", spellcheck: "true" },
    });
    this.textarea.value = this.plugin.scratch;
    this.textarea.style.setProperty("--notepad-font-size", `${this.plugin.settings.fontSize}px`);
    this.textarea.addEventListener("input", () => {
      this.plugin.setScratch(this.textarea?.value ?? "");
      this.updateCount();
    });
    const footer = this.body.createDiv({ cls: "notepad-footer" });
    footer.createSpan({ cls: "notepad-count" });
    this.updateCount();

    iconButton(bar, "file-plus", "Save as note", () => void this.plugin.saveScratchAsNote());
    if (this.plugin.dailyNotesEnabled()) {
      iconButton(bar, "calendar-plus", "Add to today's daily note", () => void this.plugin.addScratchToDailyNote());
    }
    iconButton(bar, "copy", "Copy", () => void this.plugin.copyClip(this.plugin.scratch));
    bar.createDiv({ cls: "notepad-spacer" });
    confirmButton(bar, "eraser", "Clear", () => {
      this.plugin.setScratch("");
      if (this.textarea) this.textarea.value = "";
      this.updateCount();
    });
  }

  private updateCount(): void {
    const el = this.body.querySelector(".notepad-count");
    if (!el) return;
    const text = this.plugin.scratch;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    el.setText(`${words} words · ${text.length} characters`);
  }

  // ───────────────────────── clipboard ─────────────────────────

  private renderClipboard(): void {
    const bar = this.body.createDiv({ cls: "notepad-toolbar" });
    const search = bar.createEl("input", { cls: "notepad-search", attr: { type: "search", placeholder: "Search history…" } });
    search.value = this.clipQuery;
    search.addEventListener("input", () => {
      this.clipQuery = search.value;
      this.renderClipList();
    });
    confirmButton(bar, "trash-2", "Clear history (pinned entries stay)", () => this.plugin.clearClips());

    const s = this.plugin.settings;
    if (!s.clipboardWatch) {
      this.body.createDiv({ cls: "notepad-hint", text: "Recording is off. Turn it on in the settings." });
    } else if (!this.plugin.systemClipboardAvailable) {
      this.body.createDiv({ cls: "notepad-hint", text: "Only copies made inside Obsidian are recorded on this device." });
    }
    this.clipList = this.body.createDiv({ cls: "notepad-list" });
    this.renderClipList();
  }

  private renderClipList(): void {
    const list = this.clipList;
    if (!list) return;
    list.empty();
    const q = this.clipQuery.trim().toLowerCase();
    const clips = this.plugin.clips.filter((c) => !q || c.text.toLowerCase().includes(q));
    // Pinned entries first, each group newest first (the stored order).
    const ordered = [...clips.filter((c) => c.pinned), ...clips.filter((c) => !c.pinned)];
    if (ordered.length === 0) {
      list.createDiv({ cls: "notepad-empty", text: q ? "No matches." : "Copied text will appear here." });
      return;
    }
    for (const clip of ordered) {
      const row = list.createDiv({ cls: "notepad-clip" });
      row.toggleClass("is-pinned", !!clip.pinned);
      const main = row.createDiv({ cls: "notepad-clip-main", attr: { "aria-label": "Click to copy" } });
      main.createDiv({ cls: "notepad-clip-text", text: clip.text });
      main.createDiv({ cls: "notepad-clip-meta", text: relativeTime(clip.at) + (clip.text.length > 200 ? ` · ${clip.text.length} characters` : "") });
      main.addEventListener("click", () => void this.plugin.copyClip(clip.text));
      const actions = row.createDiv({ cls: "notepad-clip-actions" });
      iconButton(actions, "text-cursor-input", "Insert into note", () => this.plugin.insertIntoNote(clip.text));
      iconButton(actions, "notebook-pen", "Add to scratch page", () => this.plugin.appendToScratch(clip.text));
      iconButton(actions, clip.pinned ? "pin-off" : "pin", clip.pinned ? "Unpin" : "Pin", () => this.plugin.togglePin(clip)).toggleClass(
        "is-active",
        !!clip.pinned
      );
      iconButton(actions, "x", "Remove", () => this.plugin.removeClip(clip));
    }
  }

  // ───────────────────────── timebox ─────────────────────────

  private async renderTimebox(): Promise<void> {
    const timebox = getTimebox(this.app);
    const body = this.body;
    if (!timebox) {
      this.stopTimer();
      body.empty();
      const box = body.createDiv({ cls: "notepad-empty" });
      box.createDiv({ text: "The Timebox plugin is not installed or not enabled." });
      box.createDiv({ cls: "notepad-hint", text: "Enable Timebox to see running sessions and tracked time here." });
      return;
    }
    const sessions = await this.plugin.timeboxIndex.sessions();
    if (this.shown !== "timebox" || this.body !== body) return;
    this.stopTimer();
    body.empty();

    const bar = body.createDiv({ cls: "notepad-toolbar" });
    textButton(bar, "play", "Start session", () => this.startTimebox());
    bar.createDiv({ cls: "notepad-spacer" });

    // Running sessions: Timebox's active list is the source of truth.
    const activeEl = body.createDiv({ cls: "notepad-section" });
    const timers: { el: HTMLElement; start: number }[] = [];
    let signature = "";
    const drawActive = () => {
      activeEl.empty();
      timers.length = 0;
      signature = timebox.active.map((a) => a.path + a.start).join("|");
      if (timebox.active.length === 0) return;
      activeEl.createDiv({ cls: "notepad-heading", text: "Running" });
      for (const a of timebox.active) {
        const start = parseTime(a.start)?.date;
        const row = activeEl.createDiv({ cls: "notepad-session is-running" });
        const info = row.createDiv({ cls: "notepad-session-info" });
        info.createDiv({ cls: "notepad-session-topic", text: a.topic || basename(a.path) });
        info.createDiv({ cls: "notepad-session-meta", text: basename(a.path) + (a.mode === "pomodoro" ? " · pomodoro" : "") });
        info.addEventListener("click", () => void this.openNote(a.path));
        const t = row.createDiv({ cls: "notepad-timer" });
        if (start) timers.push({ el: t, start: start.getTime() });
        iconButton(row, "square", "Finish", async () => {
          await timebox.stopSession({ path: a.path, start: a.start });
          drawActive();
        });
      }
      tick();
    };
    const tick = () => {
      if (timebox.active.map((a) => a.path + a.start).join("|") !== signature) {
        drawActive();
        return;
      }
      const now = Date.now();
      for (const t of timers) t.el.setText(formatTimer(now - t.start));
    };
    drawActive();
    this.timer = window.setInterval(tick, 1000);

    // Only count unfinished blocks that Timebox is actually running; others are abandoned.
    const running = new Set(timebox.active.map((a) => a.path + "\n" + a.start));
    const counted = sessions.filter((s) => s.end || running.has(s.path + "\n" + stamp(s.start)));

    const now = new Date();
    const today = startOfDay(now);
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const week = startOfWeek(now);
    const sum = (from: Date) => counted.reduce((n, s) => n + overlapMs(s, from, tomorrow, now), 0);

    const stats = body.createDiv({ cls: "notepad-stats" });
    stat(stats, "Today", formatDuration(sum(today)));
    stat(stats, "This week", formatDuration(sum(week)));

    const topics = totalsByTopic(counted, week, tomorrow, now).slice(0, 6);
    if (topics.length) {
      const sec = body.createDiv({ cls: "notepad-section" });
      sec.createDiv({ cls: "notepad-heading", text: "This week by topic" });
      const max = topics[0].ms;
      for (const t of topics) {
        const row = sec.createDiv({ cls: "notepad-topic" });
        const label = row.createDiv({ cls: "notepad-topic-label" });
        label.createSpan({ text: t.topic || "(no topic)" });
        label.createSpan({ cls: "notepad-topic-time", text: formatDuration(t.ms) });
        const track = row.createDiv({ cls: "notepad-bar" });
        track.createDiv({ cls: "notepad-bar-fill" }).style.setProperty("--notepad-bar", `${Math.max(3, (t.ms / max) * 100)}%`);
      }
    }

    // Finished sessions of the last N days, newest first, grouped by day.
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (this.plugin.settings.timeboxDays - 1));
    const finished = sessions
      .filter((s): s is IndexedSession & { end: Date } => !!s.end && s.end >= from)
      .sort((a, b) => b.start.getTime() - a.start.getTime());
    const hist = body.createDiv({ cls: "notepad-section" });
    hist.createDiv({ cls: "notepad-heading", text: "History" });
    if (finished.length === 0) {
      hist.createDiv({ cls: "notepad-empty", text: "No finished sessions yet." });
      return;
    }
    let currentDay = "";
    let dayTotalEl: HTMLElement | null = null;
    let dayTotal = 0;
    for (const s of finished) {
      const key = dayKey(s.start);
      if (key !== currentDay) {
        currentDay = key;
        dayTotal = 0;
        const head = hist.createDiv({ cls: "notepad-day" });
        head.createSpan({ text: dayLabel(s.start, today) });
        dayTotalEl = head.createSpan({ cls: "notepad-day-total" });
      }
      dayTotal += s.end.getTime() - s.start.getTime();
      dayTotalEl?.setText(formatDuration(dayTotal));
      const row = hist.createDiv({ cls: "notepad-session" });
      const info = row.createDiv({ cls: "notepad-session-info" });
      info.createDiv({ cls: "notepad-session-topic", text: s.topic || basename(s.path) });
      info.createDiv({ cls: "notepad-session-meta", text: `${formatClock(s.start)}–${formatClock(s.end)} · ${basename(s.path)}` });
      row.createDiv({ cls: "notepad-session-duration", text: formatDuration(s.end.getTime() - s.start.getTime()) });
      row.addEventListener("click", () => void this.openNote(s.path, s.line));
    }
  }

  private startTimebox(): void {
    const view = this.plugin.recentMarkdownView();
    if (!view) {
      new Notice("Open a note first to start a session.");
      return;
    }
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById("timebox:start-session");
  }

  private async openNote(path: string, line?: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ?? this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, line === undefined ? undefined : { eState: { line } });
  }
}

// ───────────────────────── small helpers ─────────────────────────

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
  const b = parent.createEl("button", { cls: "notepad-icon-button clickable-icon", attr: { "aria-label": label } });
  setIcon(b, icon);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function textButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
  const b = parent.createEl("button", { cls: "notepad-text-button" });
  setIcon(b.createSpan(), icon);
  b.createSpan({ text: label });
  b.addEventListener("click", onClick);
  return b;
}

/** A button that needs a second click within 3 s; avoids a blocking confirm dialog. */
function confirmButton(parent: HTMLElement, icon: string, label: string, onConfirm: () => void): HTMLElement {
  const b = iconButton(parent, icon, label, () => {
    if (b.hasClass("is-armed")) {
      window.clearTimeout(reset);
      b.removeClass("is-armed");
      b.setAttr("aria-label", label);
      onConfirm();
      return;
    }
    b.addClass("is-armed");
    b.setAttr("aria-label", "Click again to confirm");
    reset = window.setTimeout(() => {
      b.removeClass("is-armed");
      b.setAttr("aria-label", label);
    }, 3000);
  });
  let reset = 0;
  return b;
}

function stat(parent: HTMLElement, label: string, value: string): void {
  const el = parent.createDiv({ cls: "notepad-stat" });
  el.createDiv({ cls: "notepad-stat-value", text: value });
  el.createDiv({ cls: "notepad-stat-label", text: label });
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Timebox's `formatStamp`: "YYYY-MM-DD HH:mm:ss". */
function stamp(d: Date): string {
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dayLabel(d: Date, today: Date): string {
  const diff = Math.round((startOfDay(d).getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function relativeTime(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  const d = new Date(at);
  if (startOfDay(d).getTime() === startOfDay(new Date()).getTime()) return formatClock(d);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + formatClock(d);
}
