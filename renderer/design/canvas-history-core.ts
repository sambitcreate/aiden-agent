// Undo and redo for the design canvas: whole documents, newest last. Pure, so
// the hook can keep the history in React state and tests need no DOM.

import type { DesignCanvas } from "../shared/design-canvas/schema";

export interface CanvasHistory {
  past: DesignCanvas[];
  future: DesignCanvas[];
}

export const CANVAS_HISTORY_LIMIT = 100;

/** Remembers `before` as the state an edit started from. A new edit ends any redo. */
export function record(
  history: CanvasHistory,
  before: DesignCanvas,
  limit: number = CANVAS_HISTORY_LIMIT,
): CanvasHistory {
  const past = [...history.past, before];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

export function undo(
  history: CanvasHistory,
  current: DesignCanvas,
): { history: CanvasHistory; doc: DesignCanvas } | null {
  const doc = history.past[history.past.length - 1];
  if (!doc) return null;
  return { doc, history: { past: history.past.slice(0, -1), future: [current, ...history.future] } };
}

export function redo(
  history: CanvasHistory,
  current: DesignCanvas,
): { history: CanvasHistory; doc: DesignCanvas } | null {
  const [doc, ...future] = history.future;
  if (!doc) return null;
  return { doc, history: { past: [...history.past, current], future } };
}

/**
 * The edit that turns `from` into `to`, as a function that can also run on a
 * different canvas: it adds, removes and replaces only the frames that differ
 * between the two, so frames someone else changed in the meantime are kept.
 * Pages (names and order) and the page on screen are taken whole when the
 * edit changed them; each page keeps the view it has now, since panning is
 * not an edit. Run on `from` itself it gives exactly `to`.
 */
export function changesBetween(
  from: DesignCanvas,
  to: DesignCanvas,
): (doc: DesignCanvas) => DesignCanvas {
  const before = new Map(from.frames.map((frame) => [frame.id, frame]));
  const after = new Map(to.frames.map((frame) => [frame.id, frame]));
  const outline = (doc: DesignCanvas) => JSON.stringify(doc.pages.map((page) => [page.id, page.name]));
  const pagesChanged = outline(from) !== outline(to);
  const activeChanged = from.activePageId !== to.activePageId;
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
    const views = new Map(doc.pages.map((page) => [page.id, page.viewport]));
    const pages = pagesChanged
      ? to.pages.map((page) => {
          const viewport = views.get(page.id);
          return viewport ? { ...page, viewport } : page;
        })
      : doc.pages;
    const wanted = activeChanged ? to.activePageId : doc.activePageId;
    const activePageId = pages.some((page) => page.id === wanted) ? wanted : pages[0]!.id;
    return { ...doc, frames, pages, activePageId };
  };
}
