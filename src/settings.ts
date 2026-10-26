import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
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
  for (const id of TAB_IDS) if (typeof rawTabs[id] === "boolean") tabs[id] = rawTabs[id];
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

const SAVE_FOLDER_DESC = "Folder for notes saved from the scratch page. Leave empty for the vault root.";
const CLIPBOARD_DESC = Platform.isDesktopApp
  ? "Remember text copied anywhere on the computer while Obsidian is running."
  : "On mobile only copies made inside Obsidian are recorded.";

export class NotepadSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NotepadPlugin) {
    super(app, plugin);
  }

  // ───────────── Obsidian 1.13+: declarative settings (also indexed by the settings search) ─────────────
  // Obsidian calls getSettingDefinitions() and skips display(); older versions only call display().
  // Keep both in sync when adding or changing a setting.

  getSettingDefinitions(): SettingDefinitionItem[] {
    const d = DEFAULT_SETTINGS;
    const number = (key: "clipboardMax" | "clipboardInterval" | "timeboxDays", min: number, max: number) => ({
      type: "number" as const,
      key,
      min,
      max,
      step: 1,
      defaultValue: d[key],
      validate: (v: number) => (Number.isInteger(v) && v >= min && v <= max ? undefined : `Enter a whole number from ${min} to ${max}.`),
    });
    return [
      {
        type: "group",
        heading: "Tabs",
        items: TAB_IDS.map((id) => ({
          name: `Show ${TAB_LABELS[id].toLowerCase()} tab`,
          control: { type: "toggle" as const, key: `tabs.${id}`, defaultValue: true },
        })),
      },
      {
        type: "group",
        heading: "Notes",
        items: [
          { name: "Save folder", desc: SAVE_FOLDER_DESC, control: { type: "folder", key: "saveFolder", includeRoot: true } },
          { name: "Open the note after saving", control: { type: "toggle", key: "openSavedNote", defaultValue: d.openSavedNote } },
          {
            name: "Clear after saving",
            desc: "Empty the scratch page after it is saved as a note or added to the daily note.",
            control: { type: "toggle", key: "clearAfterSave", defaultValue: d.clearAfterSave },
          },
          { name: "Font size", control: { type: "slider", key: "fontSize", min: 10, max: 28, step: 1, defaultValue: d.fontSize } },
        ],
      },
      {
        type: "group",
        heading: "Clipboard",
        items: [
          { name: "Record clipboard history", desc: CLIPBOARD_DESC, control: { type: "toggle", key: "clipboardWatch", defaultValue: d.clipboardWatch } },
          { name: "History size", desc: "Pinned entries don't count toward the limit.", control: number("clipboardMax", 5, 1000) },
          { name: "Check interval (ms)", desc: "How often the system clipboard is checked.", control: number("clipboardInterval", 300, 10_000) },
        ],
      },
      {
        type: "group",
        heading: "Timebox",
        items: [{ name: "Days of history", desc: "How many days of finished sessions to list.", control: number("timeboxDays", 1, 90) }],
      },
      {
        type: "group",
        heading: "Colors",
        extraButtons: [
          (b) =>
            b
              .setIcon("rotate-ccw")
              .setTooltip("Follow the theme")
              .onClick(async () => {
                const st = this.plugin.settings;
                st.accentColor = st.backgroundColor = st.textColor = "";
                await this.plugin.saveSettings();
                (this as { update?: () => void }).update?.();
              }),
        ],
        items: [
          { name: "Accent color", desc: "Tabs, buttons and progress bars.", control: { type: "color", key: "accentColor" } },
          { name: "Background color", control: { type: "color", key: "backgroundColor" } },
          { name: "Text color", control: { type: "color", key: "textColor" } },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    if (key.startsWith("tabs.")) return settings.tabs[key.slice(5) as TabId];
    const v = (settings as unknown as Record<string, unknown>)[key];
    return v === "" ? undefined : v; // empty color = follow the theme
  }

  /** Saves through the plugin so data.json keeps the scratch page and clipboard history. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    const next = key.startsWith("tabs.")
      ? { ...settings, tabs: { ...settings.tabs, [key.slice(5)]: value } }
      : { ...settings, [key]: key === "saveFolder" && typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : value };
    this.plugin.settings = sanitizeSettings(next);
    await this.plugin.saveSettings();
  }

  // ───────────── Obsidian < 1.13: imperative settings ─────────────

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
      .setDesc(SAVE_FOLDER_DESC)
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
        .onChange(async (v) => {
          s.fontSize = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("Clipboard").setHeading();
    new Setting(containerEl)
      .setName("Record clipboard history")
      .setDesc(CLIPBOARD_DESC)
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
