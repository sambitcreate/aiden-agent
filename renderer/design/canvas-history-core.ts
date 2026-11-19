// Undo and redo for the design canvas: whole documents, newest last. Pure, so
// the hook can keep the history in React state and tests need no DOM.

import type { DesignCanvas } from "../shared/design-canvas/schema";

export interface CanvasHistory {
  past: DesignCanvas[];
  future: DesignCanvas[];
  /**
   * The Aiden reply whose canvas changes the newest undo step holds, while
   * that reply's later changes still join it. Any edit, undo or redo of the
   * person's own ends it.
   */
  aidenTurn?: string;
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
 * Takes in a canvas another writer saved (`from` was the stored canvas this
 * history was built on, `to` the newer one; `before` is what was on screen).
 * Aiden's changes from one reply, `aidenTurn`, become one undo step back to
 * `before`, or join the step its earlier changes made while the person has
 * not edited since. Anything else (another window, or a change we cannot
 * tell is Aiden's) is not undoable here, so every kept step takes it in and
 * undo never takes it back. Pass `to` through `keepUnchanged` first.
 */
export function takeIn(
  history: CanvasHistory,
  change: { before: DesignCanvas; from: DesignCanvas; to: DesignCanvas; aidenTurn?: string },
  limit: number = CANVAS_HISTORY_LIMIT,
): CanvasHistory {
  if (change.aidenTurn === undefined) {
    const carry = changesBetween(change.from, change.to);
    const kept: CanvasHistory = { past: history.past.map(carry), future: history.future.map(carry) };
    return history.aidenTurn === undefined ? kept : { ...kept, aidenTurn: history.aidenTurn };
  }
  // Undoing the reply's step takes its changes away, so older steps never hold them.
  if (history.past.length > 0 && history.aidenTurn === change.aidenTurn) {
    // The step already goes back to before this reply's first change.
    return { past: history.past, future: [], aidenTurn: change.aidenTurn };
  }
  return { ...record(history, change.before, limit), aidenTurn: change.aidenTurn };
}

/**
 * An edit the person made without an undo step of its own (a text frame
 * growing to fit, a comment marked resolved, another page shown). While the
 * newest step is an Aiden reply's, the edit would otherwise join that step and
 * undoing the reply would take it back too, so it is made in every kept step
 * instead, and the reply's later changes still join the reply's step. After
 * the person's own step it joins that step, the way the rest of a drag does.
 */
export function carryUnrecorded(history: CanvasHistory, edit: (doc: DesignCanvas) => DesignCanvas): CanvasHistory {
  if (history.aidenTurn === undefined) return history;
  return { past: history.past.map(edit), future: history.future.map(edit), aidenTurn: history.aidenTurn };
}

/**
 * `to` with each frame and comment that is the same as in `from` replaced by
 * `from`'s own, so `changesBetween` and the canvas see only what changed. A
 * canvas fetched from main is all new objects even where nothing changed.
 */
export function keepUnchanged(from: DesignCanvas, to: DesignCanvas): DesignCanvas {
  const reuse = <T extends { id: string }>(was: readonly T[], now: T[]): T[] => {
    const earlier = new Map(was.map((item) => [item.id, item]));
    return now.map((item) => {
      const same = earlier.get(item.id);
      return same && JSON.stringify(same) === JSON.stringify(item) ? same : item;
    });
  };
  return { ...to, frames: reuse(from.frames, to.frames), comments: reuse(from.comments, to.comments) };
}

/**
 * The edit that turns `from` into `to`, as a function that can also run on a
 * different canvas: it adds, removes and replaces only the frames and
 * comments that differ between the two, so ones someone else changed in the
 * meantime are kept. Comments whose frame or page is gone go with it.
 * Pages (names and order) and the page on screen are taken whole when the
 * edit changed them; each page keeps the view it has now, since panning is
 * not an edit. Run on `from` itself it gives exactly `to`.
 */
export function changesBetween(
  from: DesignCanvas,
  to: DesignCanvas,
): (doc: DesignCanvas) => DesignCanvas {
  const frameEdit = itemChanges(from.frames, to.frames);
  const commentEdit = itemChanges(from.comments, to.comments);
  const outline = (doc: DesignCanvas) => JSON.stringify(doc.pages.map((page) => [page.id, page.name]));
  const pagesChanged = outline(from) !== outline(to);
  const activeChanged = from.activePageId !== to.activePageId;
  return (doc) => {
    if (doc === from) return to;
    const frames = frameEdit(doc.frames);
    const views = new Map(doc.pages.map((page) => [page.id, page.viewport]));
    const pages = pagesChanged
      ? to.pages.map((page) => {
          const viewport = views.get(page.id);
          return viewport ? { ...page, viewport } : page;
        })
      : doc.pages;
    const wanted = activeChanged ? to.activePageId : doc.activePageId;
    const activePageId = pages.some((page) => page.id === wanted) ? wanted : pages[0]!.id;
    const pageIds = new Set(pages.map((page) => page.id));
    const framePages = new Map(frames.map((frame) => [frame.id, frame.pageId]));
    const comments = commentEdit(doc.comments).flatMap((comment) => {
      if (comment.frameId === undefined) return pageIds.has(comment.pageId) ? [comment] : [];
      const pageId = framePages.get(comment.frameId);
      if (pageId === undefined) return [];
      return [pageId === comment.pageId ? comment : { ...comment, pageId }];
    });
    return { ...doc, frames, pages, activePageId, comments };
  };
}

/** Adds, removes and replaces only the items (by id) that differ between `from` and `to`. */
function itemChanges<T extends { id: string }>(from: readonly T[], to: readonly T[]): (items: readonly T[]) => T[] {
  const before = new Map(from.map((item) => [item.id, item]));
  const after = new Map(to.map((item) => [item.id, item]));
  return (items) => {
    const next = items.flatMap((item) => {
      if (!before.has(item.id)) return [item];
      const changed = after.get(item.id);
      if (!changed) return [];
      return [before.get(item.id) === changed ? item : changed];
    });
    const present = new Set(next.map((item) => item.id));
    for (const item of to) {
      if (!before.has(item.id) && !present.has(item.id)) next.push(item);
    }
    return next;
  };
}
