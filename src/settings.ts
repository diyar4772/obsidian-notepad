import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type NotepadPlugin from "./main";

export const TAB_IDS = ["notes", "clipboard", "timebox"] as const;
export type TabId = (typeof TAB_IDS)[number];

export const TAB_LABELS: Record<TabId, string> = {
  notes: "Notes",
  clipboard: "Clipboard",
  timebox: "Timebox",
};

export interface NotepadSettings {
  tabs: Record<TabId, boolean>;
  /** Folder for "Save as note"; empty = vault root. */
  saveFolder: string;
  openSavedNote: boolean;
  clearAfterSave: boolean;
  fontSize: number;
  clipboardWatch: boolean;
  clipboardInterval: number; // ms
  clipboardMax: number;
  timeboxDays: number;
  /** Colors as #rrggbb; empty = follow the theme. */
  accentColor: string;
  backgroundColor: string;
  textColor: string;
}

export const DEFAULT_SETTINGS: NotepadSettings = {
  tabs: { notes: true, clipboard: true, timebox: true },
  saveFolder: "",
  openSavedNote: false,
  clearAfterSave: false,
  fontSize: 14,
  clipboardWatch: true,
  clipboardInterval: 1000,
  clipboardMax: 100,
  timeboxDays: 7,
  accentColor: "",
  backgroundColor: "",
  textColor: "",
};

const isColor = (v: unknown): v is string => typeof v === "string" && (v === "" || /^#[0-9a-f]{6}$/i.test(v));

function num(v: unknown, min: number, max: number, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
}

/** Validates settings loaded from data.json; broken fields fall back to defaults. */
export function sanitizeSettings(raw: unknown): NotepadSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const rawTabs = (r.tabs && typeof r.tabs === "object" ? r.tabs : {}) as Record<string, unknown>;
  const tabs = { ...d.tabs };
  for (const id of TAB_IDS) if (typeof rawTabs[id] === "boolean") tabs[id] = rawTabs[id] as boolean;
  return {
    tabs,
    saveFolder: typeof r.saveFolder === "string" ? r.saveFolder : d.saveFolder,
    openSavedNote: typeof r.openSavedNote === "boolean" ? r.openSavedNote : d.openSavedNote,
    clearAfterSave: typeof r.clearAfterSave === "boolean" ? r.clearAfterSave : d.clearAfterSave,
    fontSize: num(r.fontSize, 10, 28, d.fontSize),
    clipboardWatch: typeof r.clipboardWatch === "boolean" ? r.clipboardWatch : d.clipboardWatch,
    clipboardInterval: num(r.clipboardInterval, 300, 10_000, d.clipboardInterval),
    clipboardMax: num(r.clipboardMax, 5, 1000, d.clipboardMax),
    timeboxDays: num(r.timeboxDays, 1, 90, d.timeboxDays),
    accentColor: isColor(r.accentColor) ? r.accentColor : d.accentColor,
    backgroundColor: isColor(r.backgroundColor) ? r.backgroundColor : d.backgroundColor,
    textColor: isColor(r.textColor) ? r.textColor : d.textColor,
  };
}

type ColorKey = "accentColor" | "backgroundColor" | "textColor";

export class NotepadSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NotepadPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Tabs").setHeading();
    for (const id of TAB_IDS) {
      new Setting(containerEl).setName(`Show ${TAB_LABELS[id].toLowerCase()} tab`).addToggle((t) =>
        t.setValue(s.tabs[id]).onChange(async (v) => {
          s.tabs[id] = v;
          await this.plugin.saveSettings();
        })
      );
    }

    new Setting(containerEl).setName("Notes").setHeading();
    new Setting(containerEl)
      .setName("Save folder")
      .setDesc("Where \"Save as note\" creates notes. Leave empty for the vault root.")
      .addText((t) =>
        t.setPlaceholder("Inbox").setValue(s.saveFolder).onChange(async (v) => {
          s.saveFolder = v.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl).setName("Open the note after saving").addToggle((t) =>
      t.setValue(s.openSavedNote).onChange(async (v) => {
        s.openSavedNote = v;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl)
      .setName("Clear after saving")
      .setDesc("Empty the scratch page after it is saved as a note or added to the daily note.")
      .addToggle((t) =>
        t.setValue(s.clearAfterSave).onChange(async (v) => {
          s.clearAfterSave = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl).setName("Font size").addSlider((sl) =>
      sl
        .setLimits(10, 28, 1)
        .setValue(s.fontSize)
        .setDynamicTooltip()
        .onChange(async (v) => {
          s.fontSize = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("Clipboard").setHeading();
    new Setting(containerEl)
      .setName("Record clipboard history")
      .setDesc(
        Platform.isDesktopApp
          ? "Remember text copied anywhere on the computer while Obsidian is running."
          : "On mobile only copies made inside Obsidian are recorded."
      )
      .addToggle((t) =>
        t.setValue(s.clipboardWatch).onChange(async (v) => {
          s.clipboardWatch = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("History size")
      .setDesc("Pinned entries don't count toward the limit.")
      .addText((t) =>
        t.setValue(String(s.clipboardMax)).onChange(async (v) => {
          s.clipboardMax = sanitizeSettings({ clipboardMax: Number(v) }).clipboardMax;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Check interval (ms)")
      .setDesc("How often the system clipboard is checked.")
      .addText((t) =>
        t.setValue(String(s.clipboardInterval)).onChange(async (v) => {
          s.clipboardInterval = sanitizeSettings({ clipboardInterval: Number(v) }).clipboardInterval;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Timebox").setHeading();
    new Setting(containerEl)
      .setName("Days of history")
      .setDesc("How many days of finished sessions to list.")
      .addText((t) =>
        t.setValue(String(s.timeboxDays)).onChange(async (v) => {
          s.timeboxDays = sanitizeSettings({ timeboxDays: Number(v) }).timeboxDays;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Colors").setHeading();
    this.color("Accent color", "Tabs, buttons and progress bars.", "accentColor");
    this.color("Background color", "", "backgroundColor");
    this.color("Text color", "", "textColor");
  }

  private color(name: string, desc: string, key: ColorKey): void {
    const s = this.plugin.settings;
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc || "Leave on reset to follow the theme.")
      .addColorPicker((c) =>
        c.setValue(s[key] || "#888888").onChange(async (v) => {
          s[key] = v;
          await this.plugin.saveSettings();
        })
      )
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Follow the theme")
          .onClick(async () => {
            s[key] = "";
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
