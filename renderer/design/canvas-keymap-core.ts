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
import type { DesignDrawTool } from "./design-drawing";

/** The drawing tools' keys, as `aria-keyshortcuts` writes them. */
export const DESIGN_DRAW_SHORTCUTS = Object.freeze({
  text: "T",
  frame: "F",
  rect: "R",
  oval: "O",
  arrow: "Shift+L",
  line: "L",
  pencil: "P",
  pen: "Shift+P",
} as const satisfies Record<DesignDrawTool, string>);

const DRAW_KEYS: Record<string, { plain?: DesignDrawTool; shift?: DesignDrawTool }> = {
  KeyT: { plain: "text" },
  KeyF: { plain: "frame" },
  KeyR: { plain: "rect" },
  KeyO: { plain: "oval" },
  KeyL: { plain: "line", shift: "arrow" },
  KeyP: { plain: "pencil", shift: "pen" },
};

export type DesignCanvasCommand =
  | CanvasCommand
  | { type: "undo" }
  | { type: "redo" }
  | { type: "duplicate" }
  | { type: "delete" }
  | { type: "fitSelection" }
  | { type: "escape" }
  | { type: "enter" }
  | { type: "rename" }
  | { type: "addNote" }
  | { type: "comment" }
  | { type: "draw"; tool: DesignDrawTool };

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
    if (!event.shiftKey && (event.code === "Enter" || event.code === "NumpadEnter")) return { type: "enter" };
    if (event.shiftKey && event.code === "Digit2") return { type: "fitSelection" };
    if (!event.shiftKey && event.code === "F2") return { type: "rename" };
    if (!event.shiftKey && event.code === "KeyN") return { type: "addNote" };
    if (!event.shiftKey && event.code === "KeyC") return { type: "comment" };
    const draw = DRAW_KEYS[event.code];
    const tool = event.shiftKey ? draw?.shift : draw?.plain;
    if (tool) return { type: "draw", tool };
  }
  return resolveCanvasKey(event, { editable: false });
}
