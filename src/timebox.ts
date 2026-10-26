import { App, Events, TAbstractFile, TFile } from "obsidian";
import { readTimeboxSessions, TimeboxSession } from "./core";

/** The parts of the Timebox plugin (https://github.com/diyar4772/obsidian-timebox) Notepad uses. */
export interface TimeboxActiveEntry {
  path: string;
  start: string;
  topic: string;
  mode: "simple" | "pomodoro";
}

interface TimeboxPluginLike {
  active: TimeboxActiveEntry[];
  stopSession(ref: { path: string; start: string }): Promise<boolean>;
}

interface PluginRegistry {
  enabledPlugins?: Set<string>;
  plugins?: Record<string, unknown>;
}

export const TIMEBOX_ID = "timebox";

/** The running Timebox plugin, or null when it isn't installed and enabled. */
export function getTimebox(app: App): TimeboxPluginLike | null {
  const registry = (app as unknown as { plugins?: PluginRegistry }).plugins;
  if (!registry?.enabledPlugins?.has(TIMEBOX_ID)) return null;
  const p = registry.plugins?.[TIMEBOX_ID] as Partial<TimeboxPluginLike> | undefined;
  if (!p || !Array.isArray(p.active) || typeof p.stopSession !== "function") return null;
  return p as TimeboxPluginLike;
}

export interface IndexedSession extends TimeboxSession {
  path: string;
}

/**
 * Keeps a cache of the timebox sessions written in the vault's notes. The vault is read once,
 * the first time `sessions()` is called; after that only changed notes are re-read.
 * Fires "changed" when a note's sessions may have changed.
 */
export class TimeboxIndex extends Events {
  private cache = new Map<string, IndexedSession[]>();
  private ready: Promise<void> | null = null;

  constructor(private app: App) {
    super();
  }

  async sessions(): Promise<IndexedSession[]> {
    if (!this.ready) this.ready = this.build();
    await this.ready;
    return [...this.cache.values()].flat();
  }

  private async build(): Promise<void> {
    await Promise.all(this.app.vault.getMarkdownFiles().map((f) => this.readFile(f)));
  }

  private async readFile(file: TFile): Promise<void> {
    try {
      const text = await this.app.vault.cachedRead(file);
      // Cheap pre-check (a superset of real blocks) so notes without sessions skip the full parse.
      const found = /(`{3,}|~{3,})[ \t]*timebox/i.test(text)
        ? readTimeboxSessions(text, new Date(file.stat.ctime)).map((s) => ({ ...s, path: file.path }))
        : [];
      if (found.length) this.cache.set(file.path, found);
      else this.cache.delete(file.path);
    } catch (e) {
      console.warn("[notepad] could not read", file.path, e);
    }
  }

  async onModify(file: TAbstractFile): Promise<void> {
    if (!this.ready || !(file instanceof TFile) || file.extension !== "md") return;
    const had = this.cache.has(file.path);
    await this.readFile(file);
    if (had || this.cache.has(file.path)) this.trigger("changed");
  }

  onDelete(file: TAbstractFile): void {
    if (this.cache.delete(file.path)) this.trigger("changed");
  }

  onRename(file: TAbstractFile, oldPath: string): void {
    const list = this.cache.get(oldPath);
    if (!list) return;
    this.cache.delete(oldPath);
    this.cache.set(file.path, list.map((s) => ({ ...s, path: file.path })));
    this.trigger("changed");
  }
}
