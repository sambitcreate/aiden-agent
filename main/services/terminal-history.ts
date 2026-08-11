// Per-workspace terminal output history with control-sequence sanitization.
//
// PTY data arrives as a raw byte stream that mixes visible text with device
// control sequences. Replaying that stream verbatim — on terminal reopen, or
// when the renderer re-hydrates from snapshot — replays device *queries* too,
// and the shell answers them by echoing junk at the prompt. This store strips
// query/reply traffic (CSI/DCS/OSC) before persisting or returning history, so
// what gets replayed is only what the user actually saw.
//
// The store is deliberately network-free and synchronous-safe: it debounces
// disk writes per workspace so a noisy `npm install` doesn't thrash, and every
// write is best-effort (a terminal must never block or fail on disk trouble).

import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "node:crypto";
import { ensureUserDataDir } from "./data-store.js";
import type { TerminalHistoryStoreLike } from "./terminal.js";

export const MAX_HISTORY_LINES = 5_000;
const PERSIST_DEBOUNCE_MS = 40;

export interface TerminalHistoryStoreOptions {
  /** Directory holding one `<safe-id>.log` per workspace. */
  logsDir: string;
  /** Override for tests; production resolves via ensureUserDataDir. */
  maxLines?: number;
  /** Test seam for the debounce window. */
  debounceMs?: number;
  /** Test seam: custom timers. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * Strip device-query and device-reply escape sequences from a chunk of PTY
 * output, carrying any half-sequence across chunk boundaries via
 * `pendingControlSequence`. Returns the sanitized visible text and the new
 * pending prefix to feed into the next call.
 *
 * Stripped (so a replayed history cannot trigger a fresh shell reply):
 *   - CSI cursor-position reports (…R), device-status (…n),
 *     device-attributes (…c), DECRQM/DECRPM (…$p/…$y), XTVERSION (>q),
 *     Kitty keyboard (?u).
 *   - DCS DECRQSS ($q) and XTGETTCAP (+q) queries and their replies.
 *   - OSC foreground/background/color queries (10;? / 11;? / rgb:…).
 * Benign sequences (SGR colors, cursor moves, DECSTR, etc.) are preserved.
 *
 * Ported from t3code's `sanitizeTerminalHistoryChunk` (Manager.ts:953).
 */
export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    // ESC (0x1b) introduces a multi-byte escape sequence.
    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      // CSI: ESC [ …final-byte (0x40..0x7e).
      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      // String-terminated sequences: OSC (]), DCS (P), SOS (^), PM (^), APC (_).
      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      // ESC + intermediate (0x20..0x2f) + final (0x30..0x7e): e.g. ESC ! p.
      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    // C1 CSI (0x9b) — the single-byte form of ESC [.
    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    // C1 OSC/DCS/SOS/PM/APC single-byte forms.
    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  // Device-status report (CSI … n).
  if (finalByte === "n") return true;
  // Cursor-position report (CSI row ; col R).
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) return true;
  // Device-attributes report (CSI … c).
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) return true;
  // DECRQM mode queries (…$p) and DECRPM replies (…$y). The `$` guard keeps
  // setters like DECSTR (!p) and DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) return true;
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) return true;
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) return true;
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

// OSC 10/11/12 foreground/background/cursor color queries and rgb: replies.
function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) return value.slice(0, -2);
  const last = value.length > 0 ? value[value.length - 1] : "";
  if (last === "\u0007" || last === "\u009c") return value.slice(0, -1);
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    // BEL (0x07) or ST (0x9c) terminate.
    if (codePoint === 0x07 || codePoint === 0x9c) return index + 1;
    // ESC \ (0x1b 0x5c) terminates.
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) return null;
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

/**
 * Keep only the most recent `maxLines` lines so a long-running terminal does
 * not grow without bound. A trailing newline is preserved if present.
 */
export function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) lines.pop();
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function safeWorkspaceId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

interface PendingWorkspaceState {
  /** Sanitized history accumulated since the last disk write. */
  history: string;
  /** Carried half-sequence across chunk boundaries. */
  pendingControlSequence: string;
  /** Pending debounced write canceller. */
  cancel: () => void;
  /** True when a write is scheduled but has not fired yet. */
  writeScheduled: boolean;
}

export class TerminalHistoryStore implements TerminalHistoryStoreLike {
  private readonly maxLines: number;
  private readonly debounceMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly pending = new Map<string, PendingWorkspaceState>();

  constructor(private readonly options: TerminalHistoryStoreOptions) {
    this.maxLines = options.maxLines ?? MAX_HISTORY_LINES;
    this.debounceMs = options.debounceMs ?? PERSIST_DEBOUNCE_MS;
    this.schedule = options.schedule ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  }

  /** Create the default store rooted at `<userData>/terminal-history`. */
  static async create(): Promise<TerminalHistoryStore> {
    const logsDir = await ensureUserDataDir("terminal-history");
    return new TerminalHistoryStore({ logsDir });
  }

  async read(workspaceId: string): Promise<string> {
    const state = this.pending.get(workspaceId);
    if (state) return state.history;
    try {
      const file = path.join(this.options.logsDir, `${safeWorkspaceId(workspaceId)}.log`);
      const raw = await fs.readFile(file, "utf8");
      return capHistory(raw, this.maxLines);
    } catch {
      return "";
    }
  }

  append(workspaceId: string, data: string): void {
    let state = this.pending.get(workspaceId);
    if (!state) {
      state = {
        history: "",
        pendingControlSequence: "",
        cancel: () => {},
        writeScheduled: false,
      };
      this.pending.set(workspaceId, state);
    }
    const sanitized = sanitizeTerminalHistoryChunk(state.pendingControlSequence, data);
    state.pendingControlSequence = sanitized.pendingControlSequence;
    if (sanitized.visibleText.length > 0) {
      state.history = capHistory(`${state.history}${sanitized.visibleText}`, this.maxLines);
    }
    this.scheduleDebouncedWrite(workspaceId);
  }

  async flush(workspaceId: string): Promise<void> {
    const state = this.pending.get(workspaceId);
    if (!state?.writeScheduled) return;
    state.cancel();
    state.writeScheduled = false;
    await this.persist(workspaceId);
  }

  async clear(workspaceId: string): Promise<void> {
    const state = this.pending.get(workspaceId);
    if (state) {
      state.cancel();
      this.pending.delete(workspaceId);
    }
    try {
      await fs.unlink(path.join(this.options.logsDir, `${safeWorkspaceId(workspaceId)}.log`));
    } catch {
      // Already absent or unreadable — clearing is idempotent.
    }
  }

  private scheduleDebouncedWrite(workspaceId: string): void {
    const state = this.pending.get(workspaceId);
    if (!state || state.writeScheduled) return;
    state.writeScheduled = true;
    state.cancel = this.schedule(() => {
      void this.persist(workspaceId);
    }, this.debounceMs);
  }

  private async persist(workspaceId: string): Promise<void> {
    const state = this.pending.get(workspaceId);
    if (!state) return;
    try {
      const file = path.join(this.options.logsDir, `${safeWorkspaceId(workspaceId)}.log`);
      await fs.writeFile(file, state.history, "utf8");
    } catch {
      // A terminal must never fail or block on history-disk trouble.
    } finally {
      if (state) state.writeScheduled = false;
    }
  }
}
