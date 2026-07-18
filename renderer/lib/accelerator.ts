// Keyboard-event → Electron accelerator helpers, shared by the global-shortcut
// and dictation-hotkey recorders in settings.

import type * as React from "react";

const ARROWS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  Escape: "Escape",
};

function normalizeKey(e: React.KeyboardEvent): string | null {
  const code = e.code;
  if (e.key === " " || code === "Space") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (ARROWS[e.key]) return ARROWS[e.key];
  return null;
}

/** Build an accelerator string (e.g. "Command+Shift+D") from a key event, or null. */
export function toAccelerator(e: React.KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.metaKey) parts.push("Command");
  if (e.ctrlKey) parts.push("Control");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = normalizeKey(e);
  if (!key || parts.length === 0) return null;
  parts.push(key);
  return parts.join("+");
}

/** Render an accelerator with macOS symbols (⌘⌥⌃⇧). */
export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .replace("Command", "⌘")
    .replace("Control", "⌃")
    .replace("Alt", "⌥")
    .replace("Shift", "⇧")
    .replace(/\+/g, " ");
}
