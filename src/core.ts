// Pure logic. Must NOT import "obsidian" so it can be tested in Node.

import { findBlocks } from "./timebox-core";

// ───────────────────────── clipboard history ─────────────────────────

export interface Clip {
  text: string;
  /** Unix ms of the last time this text was copied. */
  at: number;
  pinned?: boolean;
}

/** Longer copies aren't recorded, so data.json stays small and fast to save. */
export const MAX_CLIP_LENGTH = 100_000;

/**
 * Clipboard formats password managers add to mark a copy as secret (KeePassXC, Bitwarden, 1Password…):
 * KDE/Linux, macOS (nspasteboard.org convention) and Windows.
 */
const SECRET_FORMATS = ["x-kde-passwordmanagerhint", "org.nspasteboard.concealedtype", "excludeclipboardcontentfrommonitorprocessing"];

export function isSecretCopy(formats: string[]): boolean {
  return formats.some((f) => SECRET_FORMATS.includes(f.toLowerCase()));
}

/**
 * Adds `text` to the top of the history. A text that is already in the list moves to the top
 * (keeping its pin). Whitespace-only text and text longer than MAX_CLIP_LENGTH are ignored. Unpinned entries beyond `max` are dropped,
 * oldest first; pinned entries are never dropped. Returns a new array.
 */
export function pushClip(history: Clip[], text: string, at: number, max: number): Clip[] {
  if (!text.trim() || text.length > MAX_CLIP_LENGTH) return history;
  const existing = history.find((c) => c.text === text);
  const entry: Clip = { text, at, pinned: existing?.pinned || undefined };
  const rest = history.filter((c) => c.text !== text);
  return trimClips([entry, ...rest], max);
}

export function trimClips(history: Clip[], max: number): Clip[] {
  let unpinned = 0;
  return history.filter((c) => c.pinned || ++unpinned <= max);
}

export function isClip(v: unknown): v is Clip {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.text === "string" && typeof c.at === "number" && Number.isFinite(c.at);
}

// ───────────────────────── time ─────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "1h 18m", "25m", "0m". Rounds down to whole minutes (same as Timebox). */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "01:02:03" or "02:03" for a live timer. */
export function formatTimer(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const body = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h > 0 ? `${pad(h)}:${body}` : body;
}

export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayKey(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday 00:00 of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

/** File name (without extension) for a saved scratch note: "Notepad 2026-10-26 13.45". */
export function noteBaseName(d: Date): string {
  return `Notepad ${dayKey(d)} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

// ───────────────────────── timebox blocks ─────────────────────────

export interface TimeboxSession {
  topic: string;
  start: Date;
  /** Missing for a running session. */
  end?: Date;
  mode: "simple" | "pomodoro";
  /** 0-based line of the opening fence. */
  line: number;
}

/**
 * The sessions in a note's `timebox` blocks, read with Timebox's own parser (`timebox-core.ts`),
 * so Notepad and Timebox always agree on which blocks are sessions: examples inside other code
 * blocks, callouts, lists, unclosed and invalid blocks are handled exactly as Timebox does.
 * Running sessions have no `end`.
 */
export function readTimeboxSessions(text: string, dayOf?: Date): TimeboxSession[] {
  return findBlocks(text, dayOf).map((b) => ({
    topic: b.session.topic,
    start: b.session.start,
    end: b.session.end ?? undefined,
    mode: b.session.mode,
    line: b.openLine,
  }));
}

/** Milliseconds of `s` that fall inside [from, to). A running session counts up to `now`. */
export function overlapMs(s: { start: Date; end?: Date }, from: Date, to: Date, now: Date): number {
  const a = Math.max(s.start.getTime(), from.getTime());
  const b = Math.min((s.end ?? now).getTime(), to.getTime());
  return Math.max(0, b - a);
}

export interface TopicTotal {
  topic: string;
  ms: number;
}

/** Total time per topic inside [from, to), largest first. */
export function totalsByTopic(sessions: { topic: string; start: Date; end?: Date }[], from: Date, to: Date, now: Date): TopicTotal[] {
  const map = new Map<string, number>();
  for (const s of sessions) {
    const ms = overlapMs(s, from, to, now);
    if (ms > 0) map.set(s.topic, (map.get(s.topic) ?? 0) + ms);
  }
  return [...map.entries()].map(([topic, ms]) => ({ topic, ms })).sort((a, b) => b.ms - a.ms);
}

// ───────────────────────── daily note template ─────────────────────────

/** Formats "now" (shifted by `amount` `unit`s) with a moment.js format string. */
export type DateFormatter = (format: string, amount?: number, unit?: string) => string;

/**
 * Fills a daily note template the way the Daily notes core plugin and the Calendar plugin do:
 * {{date}} and {{title}} become the note name, {{time}} the time (HH:mm), {{yesterday}} and
 * {{tomorrow}} the neighboring note names, and {{date:FORMAT}}, {{time:FORMAT}},
 * {{date+1d:FORMAT}} use a custom format and offset.
 */
export function fillDailyTemplate(template: string, title: string, noteFormat: string, fmt: DateFormatter): string {
  return template
    .replace(/{{\s*(date|time)\s*(?:([+-]\d+)([yqmwdhs]))?\s*(?::(.+?))?\s*}}/gi, (_match: string, kind: string, amount?: string, unit?: string, format?: string) => {
      if (!amount && !format) return kind.toLowerCase() === "date" ? title : fmt("HH:mm");
      const f = format?.trim() || (kind.toLowerCase() === "date" ? noteFormat : "HH:mm");
      return fmt(f, amount ? parseInt(amount, 10) : 0, unit);
    })
    .replace(/{{\s*title\s*}}/gi, title)
    .replace(/{{\s*yesterday\s*}}/gi, () => fmt(noteFormat, -1, "d"))
    .replace(/{{\s*tomorrow\s*}}/gi, () => fmt(noteFormat, 1, "d"));
}
