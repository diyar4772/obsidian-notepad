// Integration tests for src/main.ts against a fake Obsidian (test/obsidian-mock.ts, wired in by an esbuild alias).
// Views and the DOM aren't covered; check those in a real vault.

import * as assert from "assert";
import { clock, notices, TFile, Vault } from "./obsidian-mock";
import NotepadPlugin from "../src/main";
import { DEFAULT_SETTINGS, NotepadSettingTab, TAB_IDS } from "../src/settings";
import { getTimebox, TimeboxIndex } from "../src/timebox";

const tests: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

// What src/main.ts touches outside the obsidian module.
const clipboard = { text: "", formats: ["text/plain"] as string[] };
const g = globalThis as unknown as Record<string, unknown>;
g.document = {};
g.window = {
  require: (m: string) =>
    m === "electron"
      ? {
          clipboard: {
            readText: () => clipboard.text,
            writeText: (t: string) => (clipboard.text = t),
            availableFormats: () => clipboard.formats,
          },
        }
      : undefined,
  setInterval: () => 1,
  clearInterval: () => {},
};

interface Setup {
  data?: unknown;
  dailyNotes?: { enabled: boolean; options?: Record<string, string> };
  plugins?: { enabledPlugins: Set<string>; plugins: Record<string, unknown> };
}

async function setup(opts: Setup = {}) {
  notices.length = 0;
  clipboard.text = "";
  clipboard.formats = ["text/plain"];
  const vault = new Vault();
  const app = {
    vault,
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: () => {},
      on: () => ({}),
      getActiveViewOfType: () => null,
      getMostRecentLeaf: () => null,
      rootSplit: {},
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string) => vault.getAbstractFileByPath(link.endsWith(".md") ? link : link + ".md"),
    },
    internalPlugins: { getPluginById: (id: string) => (id === "daily-notes" && opts.dailyNotes ? { enabled: opts.dailyNotes.enabled, instance: { options: opts.dailyNotes.options } } : null) },
    plugins: opts.plugins,
  };
  const plugin = new NotepadPlugin(app as never, {} as never);
  (plugin as unknown as { stored: unknown }).stored = opts.data ?? null;
  await plugin.onload();
  const poll = () => (plugin as unknown as { pollClipboard(): void }).pollClipboard();
  const stored = () => (plugin as unknown as { stored: Record<string, unknown> }).stored;
  return { app, vault, plugin, poll, stored };
}

// ── state ──

test("corrupted data.json falls back to defaults and drops broken clips", async () => {
  const { plugin } = await setup({
    data: { settings: { fontSize: "big", clipboardMax: -3, accentColor: "red", tabs: { notes: "yes", timebox: false } }, scratch: 42, clips: [{ text: "ok", at: 1 }, { text: 5 }, null, "x"], activeTab: "nope" },
  });
  assert.strictEqual(plugin.settings.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.strictEqual(plugin.settings.clipboardMax, 5); // clamped to the minimum
  assert.strictEqual(plugin.settings.accentColor, "");
  assert.deepStrictEqual(plugin.settings.tabs, { notes: true, clipboard: true, timebox: false });
  assert.strictEqual(plugin.scratch, "");
  assert.deepStrictEqual(plugin.clips, [{ text: "ok", at: 1 }]);
  assert.strictEqual(plugin.activeTab, "notes");
});

// ── clipboard ──

test("the system clipboard is recorded once per change; the text present at startup is not", async () => {
  clipboard.text = "before start";
  const { plugin, poll, stored } = await setup();
  poll();
  assert.strictEqual(plugin.clips.length, 0);
  clipboard.text = "one";
  poll();
  poll();
  clipboard.text = "two";
  poll();
  assert.deepStrictEqual(plugin.clips.map((c) => c.text), ["two", "one"]);
  assert.deepStrictEqual((stored().clips as { text: string }[]).map((c) => c.text), ["two", "one"]);
});

test("copies marked secret by a password manager are never recorded", async () => {
  const { plugin, poll } = await setup();
  clipboard.text = "hunter2";
  clipboard.formats = ["text/plain", "x-kde-passwordManagerHint"];
  poll();
  clipboard.text = "normal";
  clipboard.formats = ["text/plain"];
  poll();
  assert.deepStrictEqual(plugin.clips.map((c) => c.text), ["normal"]);
});

test("lowering the history size while typing it doesn't delete entries; the next copy trims", async () => {
  const clips = Array.from({ length: 30 }, (_, i) => ({ text: `c${i}`, at: 100 - i }));
  const { plugin, poll } = await setup({ data: { clips } });
  const tab = new NotepadSettingTab(plugin.app, plugin);
  await tab.setControlValue("clipboardMax", 2); // "2" on the way to "20": clamped to 5, nothing removed
  assert.strictEqual(plugin.settings.clipboardMax, 5);
  assert.strictEqual(plugin.clips.length, 30);
  await tab.setControlValue("clipboardMax", 20);
  clipboard.text = "new";
  poll();
  assert.strictEqual(plugin.clips.length, 20);
  assert.strictEqual(plugin.clips[0].text, "new");
});

test("unpinning keeps the entry until the next copy", async () => {
  const clips = [{ text: "a", at: 3 }, { text: "b", at: 2 }, { text: "c", at: 1 }, { text: "old", at: 0, pinned: true }];
  const { plugin } = await setup({ data: { settings: { clipboardMax: 5 }, clips } });
  plugin.togglePin(plugin.clips[3]);
  assert.deepStrictEqual(plugin.clips.map((c) => [c.text, !!c.pinned]), [["a", false], ["b", false], ["c", false], ["old", false]]);
});

test("turning recording off stops the watcher", async () => {
  const { plugin } = await setup();
  const timer = () => (plugin as unknown as { watchTimer: number | null }).watchTimer;
  assert.notStrictEqual(timer(), null);
  plugin.settings.clipboardWatch = false;
  await plugin.saveSettings();
  assert.strictEqual(timer(), null);
});

test("copying an entry back puts it on the clipboard and moves it to the top without re-recording it", async () => {
  const { plugin, poll } = await setup({ data: { clips: [{ text: "a", at: 2 }, { text: "b", at: 1 }] } });
  await plugin.copyClip("b");
  assert.strictEqual(clipboard.text, "b");
  poll(); // the poller must not see its own write as a new copy
  assert.deepStrictEqual(plugin.clips.map((c) => c.text), ["b", "a"]);
});

// ── notes ──

test("save as note creates missing folders, avoids name clashes and can clear the page", async () => {
  const { plugin, vault } = await setup({ data: { settings: { saveFolder: "Inbox/Quick", clearAfterSave: false } } });
  plugin.setScratch("  first idea  ");
  const f1 = await plugin.saveScratchAsNote();
  const f2 = await plugin.saveScratchAsNote();
  assert.ok(f1 && f2);
  assert.match(f1.path, /^Inbox\/Quick\/Notepad \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.md$/);
  assert.strictEqual(f2.path, f1.path.replace(/\.md$/, " 2.md"));
  assert.strictEqual(await vault.read(f1), "first idea\n");
  assert.strictEqual(plugin.scratch, "  first idea  ");
  plugin.settings.clearAfterSave = true;
  await plugin.saveScratchAsNote();
  assert.strictEqual(plugin.scratch, "");
  assert.strictEqual(notices.filter((n) => n.startsWith("Saved as")).length, 3);
});

test("save as note reports a file standing where the folder should be", async () => {
  const { plugin, vault } = await setup({ data: { settings: { saveFolder: "Inbox" } } });
  vault.addFile("Inbox", "");
  plugin.setScratch("text");
  const error = console.error;
  console.error = () => {}; // the plugin logs the failure; keep the test output clean
  try {
    assert.strictEqual(await plugin.saveScratchAsNote(), null);
  } finally {
    console.error = error;
  }
  assert.ok(notices.some((n) => n.startsWith("Couldn't save the note") && n.includes("is a file")));
});

test("an empty scratch page isn't saved", async () => {
  const { plugin, vault } = await setup();
  plugin.setScratch("  \n ");
  assert.strictEqual(await plugin.saveScratchAsNote(), null);
  await plugin.addScratchToDailyNote();
  assert.strictEqual(vault.entries.size, 0);
});

// ── daily note ──

test("adding to the daily note creates it from the template, then appends", async () => {
  clock.now = new Date(2026, 9, 26, 13, 45);
  const { plugin, vault } = await setup({
    dailyNotes: { enabled: true, options: { folder: "70 - Journal/71 - Daily/", format: "YYYY-MM-DD", template: "Templates/Daily" } },
  });
  vault.addFile("Templates/Daily.md", "# {{title}}\nCreated {{time}}, yesterday was [[{{yesterday}}]]\n");
  plugin.setScratch("first");
  await plugin.addScratchToDailyNote();
  const file = vault.getAbstractFileByPath("70 - Journal/71 - Daily/2026-10-26.md") as TFile;
  assert.ok(file, "daily note created at the configured path");
  assert.strictEqual(await vault.read(file), "# 2026-10-26\nCreated 13:45, yesterday was [[2026-10-25]]\n\nfirst\n");
  plugin.setScratch("second");
  await plugin.addScratchToDailyNote();
  assert.strictEqual(await vault.read(file), "# 2026-10-26\nCreated 13:45, yesterday was [[2026-10-25]]\n\nfirst\n\nsecond\n");
});

test("the daily note: default format, missing template, and the core plugin turned off", async () => {
  clock.now = new Date(2026, 0, 5, 8, 0);
  const off = await setup({ dailyNotes: { enabled: false } });
  off.plugin.setScratch("x");
  await off.plugin.addScratchToDailyNote();
  assert.ok(notices.includes("Turn on the daily notes core plugin first."));
  assert.strictEqual(off.plugin.dailyNotesEnabled(), false);

  const { plugin, vault } = await setup({ dailyNotes: { enabled: true, options: { template: "Nope" } } });
  plugin.setScratch("x");
  await plugin.addScratchToDailyNote();
  assert.strictEqual(await vault.read(vault.getAbstractFileByPath("2026-01-05.md") as TFile), "x\n");
  assert.ok(notices.some((n) => n.includes("template \"Nope\" was not found")));
});

// ── settings ──

test("every setting has a declarative control, and the controls save through the plugin", async () => {
  const { plugin, stored } = await setup();
  plugin.setScratch("keep me");
  const tab = new NotepadSettingTab(plugin.app, plugin);
  const keys: string[] = [];
  const walk = (items: unknown[]) => {
    for (const it of items as { control?: { key: string }; items?: unknown[] }[]) {
      if (it.control) keys.push(it.control.key);
      if (it.items) walk(it.items);
    }
  };
  walk(tab.getSettingDefinitions());
  const expected = Object.keys(DEFAULT_SETTINGS).flatMap((k) => (k === "tabs" ? TAB_IDS.map((t) => `tabs.${t}`) : [k]));
  assert.deepStrictEqual([...keys].sort(), expected.sort());

  await tab.setControlValue("tabs.timebox", false);
  await tab.setControlValue("saveFolder", "/Inbox/");
  await tab.setControlValue("accentColor", "#ff0000");
  assert.strictEqual(plugin.settings.tabs.timebox, false);
  assert.strictEqual(plugin.settings.saveFolder, "Inbox");
  assert.strictEqual(tab.getControlValue("tabs.timebox"), false);
  assert.strictEqual(tab.getControlValue("accentColor"), "#ff0000");
  assert.strictEqual(tab.getControlValue("textColor"), undefined); // empty = follow the theme
  assert.strictEqual(stored().scratch, "keep me"); // saving settings didn't wipe the rest of data.json
});

// ── api ──

test("the API appends to the scratch page", async () => {
  const { plugin } = await setup();
  plugin.api.appendToScratch("one");
  plugin.api.appendToScratch("two");
  assert.strictEqual(plugin.api.getScratch(), "one\ntwo");
});

// ── timebox ──

test("getTimebox only returns an enabled plugin with the expected shape", async () => {
  const tb = { active: [], stopSession: async () => true };
  const app = (enabled: string[], plugins: Record<string, unknown>) => ({ plugins: { enabledPlugins: new Set(enabled), plugins } }) as never;
  assert.strictEqual(getTimebox(app(["timebox"], { timebox: tb })), tb);
  assert.strictEqual(getTimebox(app([], { timebox: tb })), null);
  assert.strictEqual(getTimebox(app(["timebox"], { timebox: { active: "no" } })), null);
  assert.strictEqual(getTimebox({} as never), null);
});

test("the timebox index reads the vault once and follows edits, renames and deletes", async () => {
  const vault = new Vault();
  const block = (topic: string) => `\`\`\`timebox\ntopic: ${topic}\nstart: 2026-10-26 09:00:00\nend: 2026-10-26 10:00:00\n\`\`\`\n`;
  const a = vault.addFile("A.md", block("Math"));
  vault.addFile("B.md", "no sessions here");
  const index = new TimeboxIndex({ vault } as never);
  let changes = 0;
  index.on("changed", () => changes++);
  assert.deepStrictEqual((await index.sessions()).map((s) => [s.path, s.topic]), [["A.md", "Math"]]);

  vault.entries.get("A.md")!.content = block("Physics");
  await index.onModify(a);
  assert.deepStrictEqual((await index.sessions()).map((s) => s.topic), ["Physics"]);

  const moved = new TFile("Courses/A.md");
  index.onRename(moved, "A.md");
  assert.deepStrictEqual((await index.sessions()).map((s) => s.path), ["Courses/A.md"]);

  index.onDelete(moved);
  assert.strictEqual((await index.sessions()).length, 0);
  assert.strictEqual(changes, 3);

  await index.onModify(vault.getAbstractFileByPath("B.md") as TFile); // still no sessions: no change event
  assert.strictEqual(changes, 3);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
    } catch (e) {
      failed++;
      console.error(`✗ ${t.name}\n  ${(e as Error).stack ?? e}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} plugin tests passed`);
  if (failed) process.exit(1);
})();
