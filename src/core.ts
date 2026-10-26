// Pure logic. Must NOT import "obsidian" so it can be tested in Node.

// ───────────────────────── clipboard history ─────────────────────────

export interface Clip {
  text: string;
  /** Unix ms of the last time this text was copied. */
  at: number;
  pinned?: boolean;
}

/**
 * Adds `text` to the top of the history. A text that is already in the list moves to the top
 * (keeping its pin). Whitespace-only text is ignored. Unpinned entries beyond `max` are dropped,
 * oldest first; pinned entries are never dropped. Returns a new array.
 */
export function pushClip(history: Clip[], text: string, at: number, max: number): Clip[] {
  if (!text.trim()) return history;
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

// Time formats accepted by Timebox: YYYY-MM-DD HH:mm(:ss) (T allowed), DD.MM.YYYY HH:mm(:ss), HH:mm(:ss).
const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_EU = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function build(y: number, mo: number, day: number, h: number, mi: number, s: number): Date | null {
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59 || s > 59) return null;
  const d = new Date(2000, mo - 1, day, h, mi, s);
  d.setFullYear(y);
  if (d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d;
}

/** Parses a Timebox time value. A bare time is placed on `dayOf`. */
export function parseTime(raw: string, dayOf?: Date): { date: Date; bare: boolean } | null {
  const v = raw.trim();
  let m = RE_ISO.exec(v);
  if (m) {
    const d = build(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
    return d && { date: d, bare: false };
  }
  m = RE_EU.exec(v);
  if (m) {
    const d = build(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] ?? 0));
    return d && { date: d, bare: false };
  }
  m = RE_TIME.exec(v);
  if (m && dayOf) {
    const d = build(dayOf.getFullYear(), dayOf.getMonth() + 1, dayOf.getDate(), +m[1], +m[2], +(m[3] ?? 0));
    return d && { date: d, bare: true };
  }
  return null;
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

const RE_OPEN = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})[ \t]*timebox[ \t]*$/i;

/**
 * Finds the `timebox` code blocks in a note and reads their sessions. This is a light,
 * read-only reader for statistics; the Timebox plugin itself owns writing the blocks.
 * Blocks without a valid start, and blocks that are never closed, are skipped.
 */
export function readTimeboxSessions(text: string, dayOf?: Date): TimeboxSession[] {
  const lines = text.split(/\r?\n/);
  const out: TimeboxSession[] = [];
  let outer: string | null = null; // fence of a non-timebox code block we are inside
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (outer) {
      if (line.trim().startsWith(outer) && /^[`~]+$/.test(line.trim())) outer = null;
      continue;
    }
    const open = RE_OPEN.exec(line);
    if (!open) {
      const other = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/.exec(line);
      if (other) outer = other[1];
      continue;
    }
    const fence = open[2];
    const body: string[] = [];
    let closed = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j].replace(/^(?:[ \t]*>)*[ \t]*/, "");
      if (inner.startsWith(fence[0].repeat(fence.length)) && /^[`~]+[ \t]*$/.test(inner)) {
        closed = j;
        break;
      }
      body.push(inner);
    }
    if (closed < 0) break;
    const s = parseSessionBody(body, dayOf, i);
    if (s) out.push(s);
    i = closed;
  }
  return out;
}

function parseSessionBody(body: string[], dayOf: Date | undefined, line: number): TimeboxSession | null {
  const fields: Record<string, string> = {};
  for (const l of body) {
    const m = /^([A-Za-z]+)[ \t]*:(.*)$/.exec(l.trim());
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  const start = fields.start ? parseTime(fields.start, dayOf) : null;
  if (!start) return null;
  let end: Date | undefined;
  if (fields.end) {
    const e = parseTime(fields.end, start.date);
    if (e) {
      end = e.date;
      // A bare end earlier than the start crossed midnight.
      if (e.bare && end < start.date) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, end.getHours(), end.getMinutes(), end.getSeconds());
      if (end < start.date) end = undefined;
    }
  }
  return {
    topic: fields.topic || "",
    start: start.date,
    end,
    mode: (fields.mode ?? "").toLowerCase().startsWith("pomo") ? "pomodoro" : "simple",
    line,
  };
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
