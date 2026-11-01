// Design canvas keys on top of the shared canvas keymap. Like it, these are
// handled on the focused canvas only. The Command chords (Control off a Mac)
// are the ones every editor uses for the same thing; the canvas handler
// prevents their default, so the Edit menu's text undo does not also run.
// Inside a text field nothing resolves: Command-Z there undoes typing.

import {
  resolveCanvasKey,
  type CanvasCommand,
  type CanvasKeyEvent,
} from "../canvas/canvas-keymap-core";

export type DesignCanvasCommand =
  | CanvasCommand
  | { type: "undo" }
  | { type: "redo" }
  | { type: "duplicate" }
  | { type: "delete" }
  | { type: "fitSelection" }
  | { type: "escape" };

export function resolveDesignCanvasKey(
  event: CanvasKeyEvent,
  context: { editable: boolean; platform: "darwin" | "other" },
): DesignCanvasCommand | null {
  if (context.editable || event.isComposing) return null;
  const command = context.platform === "darwin" ? event.metaKey : event.ctrlKey;
  const stray = context.platform === "darwin" ? event.ctrlKey : event.metaKey;
  if (command) {
    if (stray || event.altKey) return null;
    if (event.code === "KeyZ") return event.shiftKey ? { type: "redo" } : { type: "undo" };
    if (event.code === "KeyD" && !event.shiftKey && !event.repeat) return { type: "duplicate" };
    return null;
  }
  if (!stray && !event.altKey && !event.repeat) {
    if (!event.shiftKey && (event.code === "Backspace" || event.code === "Delete")) {
      return { type: "delete" };
    }
    if (!event.shiftKey && event.code === "Escape") return { type: "escape" };
    if (event.shiftKey && event.code === "Digit2") return { type: "fitSelection" };
  }
  return resolveCanvasKey(event, { editable: false });
}
