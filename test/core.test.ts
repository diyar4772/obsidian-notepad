// Tests for src/core.ts. `npm test` bundles this file with esbuild and runs it in Node.

import * as assert from "assert";
import {
  addClips,
  Clip,
  clipHash,
  fillDailyTemplate,
  isKlipperImage,
  mergeKlipperHistory,
  newKlipperItems,
  parseGVariantStrings,
  formatDuration,
  formatTimer,
  isSecretCopy,
  MAX_CLIP_LENGTH,
  noteBaseName,
  overlapMs,
  pushClip,
  readTimeboxSessions,
  startOfWeek,
  totalsByTopic,
  trimClips,
} from "../src/core";

const tests: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });
const d = (y: number, mo: number, day: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, day, h, mi, s);

// ── clipboard ──

test("pushClip adds to the top and ignores blank text", () => {
  let h: Clip[] = [];
  h = pushClip(h, "a", 1, 10);
  h = pushClip(h, "b", 2, 10);
  assert.deepStrictEqual(h.map((c) => c.text), ["b", "a"]);
  assert.strictEqual(pushClip(h, "  \n", 3, 10), h);
});

test("pushClip moves duplicates to the top and keeps the pin", () => {
  const h: Clip[] = [{ text: "b", at: 2 }, { text: "a", at: 1, pinned: true }];
  const r = pushClip(h, "a", 3, 10);
  assert.deepStrictEqual(r, [{ text: "a", at: 3, pinned: true }, { text: "b", at: 2 }]);
});

test("trimClips drops the oldest unpinned entries but never pinned ones", () => {
  const h: Clip[] = [
    { text: "4", at: 4 },
    { text: "3", at: 3, pinned: true },
    { text: "2", at: 2 },
    { text: "1", at: 1, pinned: true },
    { text: "0", at: 0 },
  ];
  assert.deepStrictEqual(trimClips(h, 2).map((c) => c.text), ["4", "3", "2", "1"]);
  assert.deepStrictEqual(trimClips(h, 0).map((c) => c.text), ["3", "1"]);
});

test("pushClip skips very long text", () => {
  assert.strictEqual(pushClip([], "x".repeat(MAX_CLIP_LENGTH + 1), 1, 10).length, 0);
  assert.strictEqual(pushClip([], "x".repeat(MAX_CLIP_LENGTH), 1, 10).length, 1);
});

test("isSecretCopy recognizes password manager hints", () => {
  assert.ok(isSecretCopy(["text/plain", "x-kde-passwordManagerHint"]));
  assert.ok(isSecretCopy(["org.nspasteboard.ConcealedType"]));
  assert.ok(isSecretCopy(["ExcludeClipboardContentFromMonitorProcessing"]));
  assert.ok(!isSecretCopy(["text/plain", "text/html"]));
});

// ── KDE clipboard history ──

test("parseGVariantStrings reads what gdbus prints, including quotes and escapes", () => {
  // Printed by GLib itself: GLib.Variant('(as)', (items,)).print_(True)
  const out = String.raw`(['plain', "it's", 'say "hi"', "both ' and \"", 'line1\nline2\ttab', 'back\\slash', 'emoji 😀 ğüşİ', 'ctrl \a\u001b end', ''],)`;
  assert.deepStrictEqual(parseGVariantStrings(out + "\n"), [
    "plain",
    "it's",
    'say "hi"',
    `both ' and "`,
    "line1\nline2\ttab",
    "back\\slash",
    "emoji 😀 ğüşİ",
    "ctrl \x07\x1b end",
    "",
  ]);
  assert.deepStrictEqual(parseGVariantStrings("(@as [],)"), []);
  assert.deepStrictEqual(parseGVariantStrings(String.raw`(['\U0001F600'],)`), ["😀"]);
});

test("parseGVariantStrings rejects anything else", () => {
  for (const bad of ["", "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown", "('a',)", "(['a',)", "(['a'],) trailing", String.raw`(['\u12'],)`, "(['unterminated],)"]) {
    assert.strictEqual(parseGVariantStrings(bad), null, bad);
  }
});

test("isKlipperImage and clipHash", () => {
  assert.ok(isKlipperImage("▨ 1920x1080 32bpp"));
  assert.ok(!isKlipperImage("▨ not an image"));
  assert.strictEqual(clipHash("abc"), clipHash("abc"));
  assert.notStrictEqual(clipHash("abc"), clipHash("abd"));
  assert.notStrictEqual(clipHash("ab"), clipHash("abc"));
});

test("newKlipperItems finds what was copied since the last read, oldest first", () => {
  assert.deepStrictEqual(newKlipperItems([], ["b", "a"]), ["a", "b"]);
  assert.deepStrictEqual(newKlipperItems(["a", "b"], ["a", "b"]), []);
  assert.deepStrictEqual(newKlipperItems(["a", "b"], ["c", "a", "b"]), ["c"]);
  assert.deepStrictEqual(newKlipperItems(["a", "b"], ["d", "c", "a", "b"]), ["c", "d"]);
  assert.deepStrictEqual(newKlipperItems(["a", "b"], ["b", "a"]), ["b"]); // b copied again
  assert.deepStrictEqual(newKlipperItems(["a", "b"], []), []); // history cleared
  assert.deepStrictEqual(newKlipperItems(["a", "b", "c"], ["b", "c"]), ["b"]); // newest removed in Klipper
  assert.deepStrictEqual(newKlipperItems(["a", "b"], ["x"]), ["x"]); // cleared, then a new copy
});

test("mergeKlipperHistory: Klipper's order wins, known entries keep time and pin, images are skipped", () => {
  const history: Clip[] = [
    { text: "X", at: 5, pinned: true },
    { text: "Y", at: 4 },
  ];
  const r = mergeKlipperHistory(history, ["K1", "X", "▨ 10x10 32bpp", "K2", "K1"], 99, 10);
  assert.deepStrictEqual(r, [
    { text: "K1", at: 99, imported: true },
    { text: "X", at: 5, pinned: true },
    { text: "K2", at: 99, imported: true },
    { text: "Y", at: 4 },
  ]);
});

test("addClips adds oldest first with increasing times", () => {
  const r = addClips([{ text: "old", at: 1 }], ["first", "▨ 5x5 8bpp", "second"], 100, 10, true);
  assert.deepStrictEqual(r, [
    { text: "second", at: 102, imported: true },
    { text: "first", at: 100, imported: true },
    { text: "old", at: 1 },
  ]);
});

// ── time ──

test("formatDuration and formatTimer", () => {
  assert.strictEqual(formatDuration(78 * 60_000 + 59_000), "1h 18m");
  assert.strictEqual(formatDuration(25 * 60_000), "25m");
  assert.strictEqual(formatDuration(-5), "0m");
  assert.strictEqual(formatTimer(65_000), "01:05");
  assert.strictEqual(formatTimer(3_725_000), "01:02:05");
});

test("startOfWeek is Monday", () => {
  assert.deepStrictEqual(startOfWeek(d(2026, 10, 26, 15)), d(2026, 10, 26)); // Monday
  assert.deepStrictEqual(startOfWeek(d(2026, 11, 1, 9)), d(2026, 10, 26)); // Sunday
});

test("noteBaseName", () => {
  assert.strictEqual(noteBaseName(d(2026, 10, 26, 9, 5)), "Notepad 2026-10-26 09.05");
});

// ── timebox blocks ──

const NOTE = [
  "# Day",
  "```timebox",
  "topic: Math Methods",
  "start: 2026-09-28 18:29:05",
  "mode: pomodoro",
  "end: 2026-09-28 19:47:05",
  "duration: 1h 18m",
  "```",
  "",
  "````markdown",
  "```timebox",
  "topic: example only",
  "start: 2026-09-28 10:00",
  "```",
  "````",
  "> [!note]",
  "> ~~~timebox",
  "> topic: Quoted",
  "> start: 23:30",
  "> end: 00:15",
  "> ~~~",
  "```timebox",
  "topic: Running",
  "start: 2026-09-29 08:00:00",
  "```",
  "```timebox",
  "topic: broken",
  "```",
].join("\n");

test("readTimeboxSessions reads blocks, skips examples and broken blocks", () => {
  const r = readTimeboxSessions(NOTE, d(2026, 9, 28));
  assert.deepStrictEqual(
    r.map((s) => [s.topic, s.mode, s.line]),
    [
      ["Math Methods", "pomodoro", 1],
      ["Quoted", "simple", 16],
      ["Running", "simple", 21],
    ]
  );
  assert.deepStrictEqual(r[0].end, d(2026, 9, 28, 19, 47, 5));
  assert.deepStrictEqual(r[1].start, d(2026, 9, 28, 23, 30));
  assert.deepStrictEqual(r[1].end, d(2026, 9, 29, 0, 15)); // crossed midnight
  assert.strictEqual(r[2].end, undefined);
});

test("readTimeboxSessions handles CRLF and an unclosed block", () => {
  const r = readTimeboxSessions("```timebox\r\ntopic: A\r\nstart: 2026-01-01 10:00\r\nend: 2026-01-01 11:00\r\n```\r\n```timebox\r\nstart: 2026-01-01 12:00");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].topic, "A");
});

test("readTimeboxSessions: a code block inside a callout ends with the callout", () => {
  const text = [
    "> [!example]",
    "> ```markdown",
    "> not closed inside the quote",
    "",
    "```timebox",
    "topic: After callout",
    "start: 2026-01-01 10:00",
    "end: 2026-01-01 10:30",
    "```",
  ].join("\n");
  assert.deepStrictEqual(readTimeboxSessions(text).map((s) => s.topic), ["After callout"]);
});

test("readTimeboxSessions: a timebox block in a callout closes implicitly when the callout ends", () => {
  const text = ["> ```timebox", "> topic: Quoted", "> start: 2026-01-01 10:00", "> end: 2026-01-01 11:00", "", "Paragraph"].join("\n");
  const r = readTimeboxSessions(text);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].topic, "Quoted");
});

test("readTimeboxSessions: fence rules", () => {
  // A closing fence must use the same character and be at least as long, with nothing after it.
  const text = [
    "````timebox",
    "topic: Long fence",
    "start: 2026-01-01 10:00",
    "```",
    "~~~~",
    "```` trailing",
    "end: 2026-01-01 11:00",
    "````",
    "```timebox`",
    "start: 2026-01-01 12:00",
    "```",
  ].join("\n");
  const r = readTimeboxSessions(text);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].topic, "Long fence");
  assert.deepStrictEqual(r[0].end, d(2026, 1, 1, 11));
  // "```timebox`" is inline code, not a fence, so its lines are ignored.
});

test("readTimeboxSessions: a full-date end before the start is an invalid block, as in Timebox", () => {
  assert.strictEqual(readTimeboxSessions("```timebox\nstart: 2026-01-02 10:00\nend: 2026-01-01 11:00\n```").length, 0);
});

test("fillDailyTemplate matches the daily notes placeholders", () => {
  const calls: string[] = [];
  const fmt = (f: string, amount = 0, unit = "") => {
    calls.push(`${f}|${amount}${unit}`);
    return `<${f}${amount ? (amount > 0 ? "+" : "") + amount + unit : ""}>`;
  };
  const tpl = "# {{title}}\n{{date}} {{ time }}\n{{date:dddd}} {{time:HH}}\n{{date+1d:YYYY}} {{yesterday}} {{tomorrow}}\n{{other}}";
  assert.strictEqual(
    fillDailyTemplate(tpl, "2026-10-26", "YYYY-MM-DD", fmt),
    "# 2026-10-26\n2026-10-26 <HH:mm>\n<dddd> <HH>\n<YYYY+1d> <YYYY-MM-DD-1d> <YYYY-MM-DD+1d>\n{{other}}"
  );
});

test("overlapMs and totalsByTopic clip sessions to the range and count running ones up to now", () => {
  const now = d(2026, 10, 26, 12);
  const sessions = [
    { topic: "A", start: d(2026, 10, 25, 23), end: d(2026, 10, 26, 1) }, // 1h inside today
    { topic: "B", start: d(2026, 10, 26, 9), end: d(2026, 10, 26, 9, 30) },
    { topic: "A", start: d(2026, 10, 26, 11, 30) }, // running: 30m
  ];
  const from = d(2026, 10, 26);
  const to = d(2026, 10, 27);
  assert.strictEqual(overlapMs(sessions[0], from, to, now), 3_600_000);
  assert.strictEqual(overlapMs(sessions[2], from, to, now), 1_800_000);
  assert.deepStrictEqual(totalsByTopic(sessions, from, to, now), [
    { topic: "A", ms: 5_400_000 },
    { topic: "B", ms: 1_800_000 },
  ]);
});

test("performance: pathological lines are read in linear time", () => {
  const t0 = Date.now();
  const lines = [" ".repeat(200_000), ">".repeat(200_000), "`".repeat(200_000), "> ".repeat(100_000) + "```timebox", "start:" + " ".repeat(200_000)];
  for (const l of lines) readTimeboxSessions(l + "\n" + l, d(2026, 1, 1));
  const many = Array.from({ length: 2000 }, (_, i) => `\`\`\`timebox\ntopic: ${i}\nstart: 2026-01-01 10:00\nend: 11:00\n\`\`\``).join("\n");
  assert.strictEqual(readTimeboxSessions(many).length, 2000);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms`);
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
  } catch (e) {
    failed++;
    console.error(`✗ ${t.name}\n  ${(e as Error).message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} tests passed`);
if (failed) process.exit(1);
