// A minimal fake of the "obsidian" module, enough to run src/main.ts in Node.
// `npm test` swaps it in through an esbuild alias (see esbuild.config.mjs). The DOM is not faked:
// views aren't opened in these tests.

/* eslint-disable @typescript-eslint/no-explicit-any */

export class TAbstractFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
}

export class TFile extends TAbstractFile {
  stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  get extension(): string {
    return this.name.includes(".") ? this.name.slice(this.name.lastIndexOf(".") + 1) : "";
  }
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
}

export class TFolder extends TAbstractFile {}

export const notices: string[] = [];
export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

export class Events {
  private handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  on(name: string, fn: (...args: any[]) => unknown): { name: string; fn: (...args: any[]) => unknown } {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return { name, fn };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
}

export class Component {
  registerEvent(): void {}
  registerDomEvent(): void {}
  registerInterval(id: number): number {
    return id;
  }
}

export class ItemView extends Component {
  contentEl: any = {};
  constructor(public leaf: unknown) {
    super();
  }
}

export class MarkdownView {}
export class PluginSettingTab {
  containerEl: any = {};
  constructor(public app: unknown, public plugin: unknown) {}
}
export class Setting {}
export function setIcon(): void {}

export const Platform = { isDesktopApp: true, isMobile: false, isLinux: true };

export function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/** Runs immediately; `run`/`cancel` exist so the plugin can call them. */
export function debounce<T extends unknown[]>(fn: (...args: T) => unknown): ((...args: T) => void) & { run(): void; cancel(): void } {
  const d = (...args: T) => void fn(...args);
  return Object.assign(d, { run: () => {}, cancel: () => {} });
}

/** The time `moment()` returns; tests set it. */
export const clock = { now: new Date(2026, 9, 26, 13, 45) };

interface FakeMoment {
  add(amount: number, unit: string): FakeMoment;
  format(f: string): string;
}
function fakeMoment(d: Date): FakeMoment {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    add(amount, unit) {
      const n = new Date(d);
      if (unit === "d") n.setDate(n.getDate() + amount);
      else throw new Error("fake moment: unsupported unit " + unit);
      return fakeMoment(n);
    },
    format(f) {
      return f.replace(/YYYY|MM|DD|HH|mm/g, (t) =>
        t === "YYYY" ? String(d.getFullYear()) : t === "MM" ? pad(d.getMonth() + 1) : t === "DD" ? pad(d.getDate()) : t === "HH" ? pad(d.getHours()) : pad(d.getMinutes())
      );
    },
  };
}
export const moment = (): FakeMoment => fakeMoment(clock.now);

/** An in-memory vault that, like Obsidian, refuses to create a file or folder whose parent is missing. */
export class Vault extends Events {
  entries = new Map<string, { file: TAbstractFile; content?: string }>();

  private parentExists(path: string): boolean {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return dir === "" || this.entries.get(dir)?.file instanceof TFolder;
  }
  addFile(path: string, content: string): TFile {
    const file = new TFile(path);
    this.entries.set(path, { file, content });
    return file;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.entries.get(path)?.file ?? null;
  }
  getMarkdownFiles(): TFile[] {
    return [...this.entries.values()].map((e) => e.file).filter((f): f is TFile => f instanceof TFile && f.extension === "md");
  }
  async createFolder(path: string): Promise<TFolder> {
    if (this.entries.has(path)) throw new Error("Folder already exists.");
    if (!this.parentExists(path)) throw new Error("Parent folder doesn't exist: " + path);
    const folder = new TFolder(path);
    this.entries.set(path, { file: folder });
    return folder;
  }
  async create(path: string, content: string): Promise<TFile> {
    if (this.entries.has(path)) throw new Error("File already exists.");
    if (!this.parentExists(path)) throw new Error("Parent folder doesn't exist: " + path);
    return this.addFile(path, content);
  }
  async read(file: TFile): Promise<string> {
    return this.entries.get(file.path)?.content ?? "";
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }
  async process(file: TFile, fn: (text: string) => string): Promise<string> {
    const entry = this.entries.get(file.path);
    if (!entry) throw new Error("File not found.");
    entry.content = fn(entry.content ?? "");
    return entry.content;
  }
}

export class Plugin extends Component {
  stored: unknown = null;
  constructor(public app: any, public manifest: unknown) {
    super();
  }
  async loadData(): Promise<unknown> {
    return this.stored;
  }
  async saveData(data: unknown): Promise<void> {
    this.stored = JSON.parse(JSON.stringify(data));
  }
  registerView(): void {}
  addSettingTab(): void {}
  addRibbonIcon(): void {}
  addCommand(): void {}
}
