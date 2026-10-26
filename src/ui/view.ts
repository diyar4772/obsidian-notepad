import { debounce, ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { dayKey, formatClock, formatDuration, formatTimer, overlapMs, startOfDay, startOfWeek, totalsByTopic } from "../core";
import { parseStamp } from "../timebox-core";
import type NotepadPlugin from "../main";
import { TAB_IDS, TAB_LABELS, TabId } from "../settings";
import { FLATPAK_PERMISSION_COMMAND, isFlatpak, isWaylandSession } from "../klipper";
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
  /** Increases on every Timebox render, so a render that finished awaiting late doesn't draw over a newer one. */
  private renderToken = 0;
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
    this.shown = null;
    this.renderTimeboxSoon.cancel();
    this.renderToken++;
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
    if (current !== this.shown || current === "clipboard") this.show(current); // clipboard hints depend on settings
    else if (current === "notes" && this.textarea) {
      this.textarea.style.setProperty("--notepad-font-size", `${this.plugin.settings.fontSize}px`);
      this.syncScratch();
    } else if (current === "timebox") void this.renderTimebox();
  }

  onClipsChanged(): void {
    if (this.shown === "clipboard") this.renderClipList();
  }

  onClipboardSourceChanged(): void {
    if (this.shown === "clipboard") this.show("clipboard");
  }

  /** Shows the current scratch text (changed elsewhere: another view, a command, the API). */
  syncScratch(): void {
    if (!this.textarea) return;
    if (this.textarea.value !== this.plugin.scratch) this.textarea.value = this.plugin.scratch;
    this.updateCount();
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
      this.plugin.setScratch(this.textarea?.value ?? "", this);
      this.updateCount();
    });
    const footer = this.body.createDiv({ cls: "notepad-footer" });
    footer.createSpan({ cls: "notepad-count" });
    this.updateCount();

    iconButton(bar, "file-plus", "Save as note", () => void this.plugin.saveScratchAsNote());
    if (this.plugin.dailyNotesEnabled()) {
      iconButton(bar, "calendar-plus", "Add to today's daily note", () => void this.plugin.addScratchToDailyNote());
    }
    iconButton(bar, "copy", "Copy", () => {
      if (this.plugin.scratch.trim()) void this.plugin.copyClip(this.plugin.scratch);
      else new Notice("The scratch page is empty.");
    });
    bar.createDiv({ cls: "notepad-spacer" });
    confirmButton(bar, "eraser", "Clear", () => this.plugin.setScratch(""));
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

    this.renderSourceHint();
    this.clipList = this.body.createDiv({ cls: "notepad-list" });
    this.renderClipList();
  }

  /** Says where copies come from, and on Wayland how to see copies made in other apps. */
  private renderSourceHint(): void {
    const source = this.plugin.clipboardSource;
    if (source === "off") {
      this.body.createDiv({ cls: "notepad-hint", text: "Recording is off. Turn it on in the settings." });
    } else if (source === "klipper") {
      this.body.createDiv({ cls: "notepad-hint", text: "Copies come from the KDE clipboard history (Klipper)." });
    } else if (source === "obsidian") {
      this.body.createDiv({ cls: "notepad-hint", text: "Only copies made inside Obsidian are recorded on this device." });
    } else if (this.plugin.klipperSupported && this.plugin.settings.klipper && isWaylandSession()) {
      const hint = this.body.createDiv({ cls: "notepad-hint" });
      hint.createDiv({ text: "Copies made in other apps are only seen when you switch back to Obsidian." });
      if (isFlatpak()) {
        hint.createDiv({ text: "On KDE Plasma, let Obsidian read the Klipper clipboard history by running this once in a terminal, then restart Obsidian:" });
        hint.createEl("code", { cls: "notepad-command", text: FLATPAK_PERMISSION_COMMAND });
      } else {
        hint.createDiv({ text: "On KDE Plasma, Notepad uses the Klipper clipboard history when Klipper is running." });
      }
    }
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
      const when = clip.imported ? "From the KDE clipboard history" : relativeTime(clip.at);
      main.createDiv({ cls: "notepad-clip-meta", text: when + (clip.text.length > 200 ? ` · ${clip.text.length} characters` : "") });
      main.addEventListener("click", () => void this.plugin.copyClip(clip.text));
      const actions = row.createDiv({ cls: "notepad-clip-actions" });
      iconButton(actions, "text-cursor-input", "Insert into note", () => void this.plugin.insertIntoNote(clip.text));
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
    const token = ++this.renderToken;
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
    if (token !== this.renderToken || this.shown !== "timebox") return;
    this.stopTimer();
    const scroll = body.scrollTop; // redraws happen while reading the list; keep its position
    body.empty();

    const bar = body.createDiv({ cls: "notepad-toolbar" });
    textButton(bar, "play", "Start session", () => void this.plugin.startTimeboxSession());
    bar.createDiv({ cls: "notepad-spacer" });

    // Running sessions come from Timebox's active list (the blocks in the notes can lag behind
    // until the note is saved). Unfinished blocks Timebox isn't running are abandoned; they're not counted.
    const running = () =>
      timebox.active.flatMap((a) => {
        const start = parseStamp(a.start);
        return start ? [{ ...a, start, startStamp: a.start }] : [];
      });
    const finished = sessions.filter((s): s is IndexedSession & { end: Date } => !!s.end);

    const now = new Date();
    const today = startOfDay(now);
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const week = startOfWeek(now);
    const finishedSum = (from: Date) => finished.reduce((n, s) => n + overlapMs(s, from, tomorrow, now), 0);
    const finishedToday = finishedSum(today);
    const finishedWeek = finishedSum(week);

    const activeEl = body.createDiv({ cls: "notepad-section" });
    const stats = body.createDiv({ cls: "notepad-stats" });
    const todayEl = stat(stats, "Today");
    const weekEl = stat(stats, "This week");

    const timers: { el: HTMLElement; start: number }[] = [];
    let signature = "";
    const signatureOf = () => timebox.active.map((a) => a.path + "\n" + a.start).join("|");
    const drawActive = () => {
      activeEl.empty();
      timers.length = 0;
      signature = signatureOf();
      const list = running();
      if (list.length === 0) return;
      activeEl.createDiv({ cls: "notepad-heading", text: "Running" });
      for (const a of list) {
        const row = activeEl.createDiv({ cls: "notepad-session is-running" });
        const info = row.createDiv({ cls: "notepad-session-info" });
        info.createDiv({ cls: "notepad-session-topic", text: a.topic || basename(a.path) });
        info.createDiv({ cls: "notepad-session-meta", text: basename(a.path) + (a.mode === "pomodoro" ? " · pomodoro" : "") });
        info.addEventListener("click", () => void this.openNote(a.path));
        timers.push({ el: row.createDiv({ cls: "notepad-timer" }), start: a.start.getTime() });
        const finish = iconButton(row, "circle-stop", "Finish", () => {
          finish.setAttr("disabled", "true");
          void timebox.stopSession({ path: a.path, start: a.startStamp }).then(drawActive);
        });
      }
    };
    const tick = () => {
      const t = new Date();
      if (t >= tomorrow) {
        void this.renderTimebox(); // a new day: Today, This week and History start over
        return;
      }
      if (signatureOf() !== signature) drawActive();
      for (const x of timers) x.el.setText(formatTimer(t.getTime() - x.start));
      // Totals grow while a session runs.
      const list = running();
      const runningSum = (from: Date) => list.reduce((n, s) => n + overlapMs(s, from, tomorrow, t), 0);
      todayEl.setText(formatDuration(finishedToday + runningSum(today)));
      weekEl.setText(formatDuration(finishedWeek + runningSum(week)));
    };
    drawActive();
    tick();
    this.timer = window.setInterval(tick, 1000);

    const topics = totalsByTopic([...finished, ...running()], week, tomorrow, now).slice(0, 6);
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

    // Finished sessions of the last N days, newest first, grouped by the day they started.
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (this.plugin.settings.timeboxDays - 1));
    const recent = finished.filter((s) => s.end >= from).sort((a, b) => b.start.getTime() - a.start.getTime());
    const hist = body.createDiv({ cls: "notepad-section" });
    hist.createDiv({ cls: "notepad-heading", text: "History" });
    if (recent.length === 0) {
      hist.createDiv({ cls: "notepad-empty", text: "No finished sessions yet." });
    }
    let currentDay = "";
    let dayTotalEl: HTMLElement | null = null;
    let dayTotal = 0;
    for (const s of recent) {
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
    body.scrollTop = scroll;
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

/** A stat tile; returns the value element. */
function stat(parent: HTMLElement, label: string): HTMLElement {
  const el = parent.createDiv({ cls: "notepad-stat" });
  const value = el.createDiv({ cls: "notepad-stat-value" });
  el.createDiv({ cls: "notepad-stat-label", text: label });
  return value;
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
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
