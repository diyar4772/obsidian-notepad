// KDE Plasma's clipboard history (Klipper), read over D-Bus with the `gdbus` command line tool.
// Klipper sees every copy, also while Obsidian is in the background on Wayland, where Obsidian
// itself only sees the clipboard while it is focused. Desktop Linux only.

import { parseGVariantStrings } from "./core";

interface ChildLike {
  stdout: { on(event: "data", fn: (chunk: unknown) => void): void } | null;
  on(event: "exit" | "error", fn: () => void): void;
  kill(): void;
}

/** The parts of Node's child_process module used here. */
export interface ChildProcessLike {
  execFile(
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
    callback: (error: Error | null, stdout: unknown) => void
  ): unknown;
  spawn(file: string, args: string[], options: { stdio: ["ignore", "pipe", "ignore"] }): ChildLike;
}

const KLIPPER = ["--session", "--dest", "org.kde.klipper", "--object-path", "/klipper"];

/** Node's child_process in the desktop app; null elsewhere. */
export function loadChildProcess(): ChildProcessLike | null {
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const cp = req?.("child_process") as Partial<ChildProcessLike> | undefined;
    return cp && typeof cp.execFile === "function" && typeof cp.spawn === "function" ? (cp as ChildProcessLike) : null;
  } catch {
    return null;
  }
}

/** True inside the Flatpak build of Obsidian, which needs a permission to talk to Klipper. */
export function isFlatpak(): boolean {
  return !!processEnv().FLATPAK_ID;
}

/** A Wayland session, where Obsidian only sees the clipboard while it's focused. */
export function isWaylandSession(): boolean {
  const env = processEnv();
  return env.XDG_SESSION_TYPE === "wayland" || !!env.WAYLAND_DISPLAY;
}

/** Environment variables of the desktop app (Node's process.env); empty elsewhere. */
function processEnv(): Record<string, string | undefined> {
  return (window as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

export const FLATPAK_PERMISSION_COMMAND = "flatpak override --user --talk-name=org.kde.klipper md.obsidian.Obsidian";

/** Klipper's history, newest first. Rejects when gdbus or Klipper isn't reachable. */
export function readKlipperHistory(cp: ChildProcessLike): Promise<string[]> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "gdbus",
      ["call", ...KLIPPER, "--method", "org.kde.klipper.klipper.getClipboardHistoryMenu"],
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const items = parseGVariantStrings(String(stdout));
        if (items) resolve(items);
        else reject(new Error("Unexpected reply from Klipper."));
      }
    );
  });
}

/**
 * Runs `gdbus monitor` and calls `onChange` when Klipper's history changes (its
 * clipboardHistoryUpdated signal, or Klipper starting again). `onEnd` runs once if the monitor
 * stops on its own; `stop()` ends it without calling `onEnd`.
 */
export class KlipperMonitor {
  private child: ChildLike | null;
  private ended = false;

  constructor(cp: ChildProcessLike, onChange: () => void, onEnd: () => void) {
    const child = cp.spawn("gdbus", ["monitor", ...KLIPPER], { stdio: ["ignore", "pipe", "ignore"] });
    this.child = child;
    let pending = "";
    child.stdout?.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (lines.some((l) => l.includes("clipboardHistoryUpdated") || l.includes("owned by"))) onChange();
    });
    const end = () => {
      if (this.ended) return;
      this.ended = true;
      this.child = null;
      onEnd();
    };
    child.on("exit", end);
    child.on("error", end);
  }

  stop(): void {
    this.ended = true;
    this.child?.kill();
    this.child = null;
  }
}
