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

/**
 * The edit that turns `from` into `to`, as a function that can also run on a
 * different canvas: it adds, removes and replaces only the frames that differ
 * between the two, so frames someone else changed in the meantime are kept.
 * Run on `from` itself it gives exactly `to`.
 */
export function changesBetween(
  from: DesignCanvasV1,
  to: DesignCanvasV1,
): (doc: DesignCanvasV1) => DesignCanvasV1 {
  const before = new Map(from.frames.map((frame) => [frame.id, frame]));
  const after = new Map(to.frames.map((frame) => [frame.id, frame]));
  const viewportChanged =
    from.viewport.x !== to.viewport.x || from.viewport.y !== to.viewport.y || from.viewport.zoom !== to.viewport.zoom;
  return (doc) => {
    if (doc === from) return to;
    const frames = doc.frames.flatMap((frame) => {
      if (!before.has(frame.id)) return [frame];
      const next = after.get(frame.id);
      if (!next) return [];
      return [before.get(frame.id) === next ? frame : next];
    });
    const present = new Set(frames.map((frame) => frame.id));
    for (const frame of to.frames) {
      if (!before.has(frame.id) && !present.has(frame.id)) frames.push(frame);
    }
    return { ...doc, frames, ...(viewportChanged ? { viewport: to.viewport } : {}) };
  };
}
