// Undo and redo for the design canvas: whole documents, newest last. Pure, so
// the hook can keep the history in React state and tests need no DOM.

import type { DesignCanvasV1 } from "../shared/design-canvas/schema";

export interface CanvasHistory {
  past: DesignCanvasV1[];
  future: DesignCanvasV1[];
}

export const CANVAS_HISTORY_LIMIT = 100;

/** Remembers `before` as the state an edit started from. A new edit ends any redo. */
export function record(
  history: CanvasHistory,
  before: DesignCanvasV1,
  limit: number = CANVAS_HISTORY_LIMIT,
): CanvasHistory {
  const past = [...history.past, before];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

export function undo(
  history: CanvasHistory,
  current: DesignCanvasV1,
): { history: CanvasHistory; doc: DesignCanvasV1 } | null {
  const doc = history.past[history.past.length - 1];
  if (!doc) return null;
  return { doc, history: { past: history.past.slice(0, -1), future: [current, ...history.future] } };
}

export function redo(
  history: CanvasHistory,
  current: DesignCanvasV1,
): { history: CanvasHistory; doc: DesignCanvasV1 } | null {
  const [doc, ...future] = history.future;
  if (!doc) return null;
  return { doc, history: { past: [...history.past, current], future } };
}
