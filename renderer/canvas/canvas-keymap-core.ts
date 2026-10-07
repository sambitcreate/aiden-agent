// Canvas keys are unmodified and handled on the focused canvas region only,
// never window-wide, so they reserve no app or global shortcut. Any Command,
// Control or Alt chord is rejected on every platform, which keeps the app's
// Command-based accelerators (Ctrl-based on Linux) and the reserved set in
// renderer/shared/keybindings.ts untouched.

export type CanvasTool = "select" | "hand";

export type CanvasCommand =
  | { type: "tool"; tool: CanvasTool }
  | { type: "zoomIn" }
  | { type: "zoomOut" }
  | { type: "zoomReset" }
  | { type: "fitView" }
  | { type: "toggleMinimap" };

export interface CanvasKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

export const CANVAS_TOOL_SHORTCUTS = Object.freeze({ select: "V", hand: "H" } as const);

export function resolveCanvasKey(
  event: CanvasKeyEvent,
  context: { editable: boolean },
): CanvasCommand | null {
  if (context.editable || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  if (event.code === "Equal" || event.key === "+") return { type: "zoomIn" };
  if (event.code === "Minus" && !event.shiftKey) return { type: "zoomOut" };
  if (event.repeat) return null;
  if (event.shiftKey) {
    if (event.code === "Digit1") return { type: "fitView" };
    if (event.code === "Digit0") return { type: "zoomReset" };
    return null;
  }
  if (event.code === "KeyV") return { type: "tool", tool: "select" };
  if (event.code === "KeyH") return { type: "tool", tool: "hand" };
  if (event.code === "KeyM") return { type: "toggleMinimap" };
  return null;
}
