// Undo and redo for the design canvas: whole documents, newest last. Pure, so
// the hook can keep the history in React state and tests need no DOM.

import { DESIGN_CANVAS_LIMITS, type DesignCanvas, type DesignPage } from "../shared/design-canvas/schema";

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
 * Pages change item by item too (`pageChanges`), and so do chats' own pages:
 * the claims the edit added, moved or removed are applied, and a claim whose
 * page is gone moves to the first page. Which page anyone looks at is not in
 * the document, so an undo never moves anyone's view. Run on `from` itself it
 * gives exactly `to`.
 */
export function changesBetween(
  from: DesignCanvas,
  to: DesignCanvas,
): (doc: DesignCanvas) => DesignCanvas {
  const frameEdit = itemChanges(from.frames, to.frames);
  const commentEdit = itemChanges(from.comments, to.comments);
  const pageEdit = pageChanges(from.pages, to.pages);
  const claimEdit = claimChanges(from.chatPages, to.chatPages);
  return (doc) => {
    if (doc === from) return to;
    const pages = pageEdit(doc.pages);
    const pageIds = new Set(pages.map((page) => page.id));
    // A frame left on a page that is gone goes with it, as comments do.
    const edited = frameEdit(doc.frames);
    const frames = edited.every((frame) => pageIds.has(frame.pageId)) ? edited : edited.filter((frame) => pageIds.has(frame.pageId));
    const chatPages = claimEdit(doc.chatPages, pageIds, pages[0]!.id);
    const framePages = new Map(frames.map((frame) => [frame.id, frame.pageId]));
    const comments = commentEdit(doc.comments).flatMap((comment) => {
      if (comment.frameId === undefined) return pageIds.has(comment.pageId) ? [comment] : [];
      const pageId = framePages.get(comment.frameId);
      if (pageId === undefined) return [];
      return [pageId === comment.pageId ? comment : { ...comment, pageId }];
    });
    return { ...doc, frames, pages, chatPages, comments };
  };
}

/**
 * The page edit that turns `from` into `to`, run on another page list: the
 * pages `to` removed go, renames and `namedFor` changes apply, a page `to`
 * added goes after the nearest page before it in `to` that is there (first
 * when none is), and pages only the other list has stay. A page's name and
 * `namedFor` each change only when the edit changed that field. When the
 * edit reordered pages, the pages both lists share take `to`'s order among
 * the places they hold. Past the page limit, pages `to` lacks are dropped.
 */
function pageChanges(from: readonly DesignPage[], to: readonly DesignPage[]): (pages: readonly DesignPage[]) => DesignPage[] {
  const before = new Map(from.map((page) => [page.id, page]));
  const after = new Map(to.map((page) => [page.id, page]));
  const sharedOrder = (list: readonly DesignPage[]) =>
    list.filter((page) => before.has(page.id) && after.has(page.id)).map((page) => page.id);
  const reordered = sharedOrder(from).join("\n") !== sharedOrder(to).join("\n");
  return (pages) => {
    let next = pages.flatMap((page): DesignPage[] => {
      const was = before.get(page.id);
      if (!was) return [page];
      const now = after.get(page.id);
      if (!now) return [];
      // Each field the edit changed, and only those, so a step's own rename stays.
      let changed = page;
      if (was.name !== now.name) changed = { ...changed, name: now.name };
      if (was.namedFor !== now.namedFor) {
        const { namedFor: _namedFor, ...rest } = changed;
        changed = now.namedFor === undefined ? rest : { ...rest, namedFor: now.namedFor };
      }
      return [changed];
    });
    if (reordered) {
      const order = new Map(to.map((page, index) => [page.id, index]));
      const ordered = next.filter((page) => before.has(page.id) && order.has(page.id));
      ordered.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      let at = 0;
      next = next.map((page) => (before.has(page.id) && order.has(page.id) ? ordered[at++]! : page));
    }
    for (const [index, page] of to.entries()) {
      if (before.has(page.id) || next.some((entry) => entry.id === page.id)) continue;
      let place = 0;
      for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
        const found = next.findIndex((entry) => entry.id === to[earlier]!.id);
        if (found >= 0) {
          place = found + 1;
          break;
        }
      }
      next = [...next.slice(0, place), page, ...next.slice(place)];
    }
    // Past the page limit, pages only the step has go first, newest first, so
    // parsing never drops a page someone else added.
    const inTo = new Set(to.map((page) => page.id));
    for (let at = next.length - 1; at >= 0 && next.length > DESIGN_CANVAS_LIMITS.pages; at -= 1) {
      if (!inTo.has(next[at]!.id)) next = [...next.slice(0, at), ...next.slice(at + 1)];
    }
    return next.length > 0 ? next : [...to];
  };
}

/**
 * The claims the edit added, moved or removed, applied to another set; a
 * claim left on a page that is gone moves to `first`.
 */
function claimChanges(
  from: Record<string, string>,
  to: Record<string, string>,
): (chatPages: Record<string, string>, pageIds: ReadonlySet<string>, first: string) => Record<string, string> {
  const own = (map: Record<string, string>, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  const changed = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((chatId) => own(from, chatId) !== own(to, chatId));
  return (chatPages, pageIds, first) => {
    const stale = Object.values(chatPages).some((pageId) => !pageIds.has(pageId));
    if (changed.length === 0 && !stale) return chatPages;
    const next: Record<string, string> = { ...chatPages };
    for (const chatId of changed) {
      const pageId = own(to, chatId);
      if (pageId === undefined) delete next[chatId];
      else next[chatId] = pageId;
    }
    for (const [chatId, pageId] of Object.entries(next)) if (!pageIds.has(pageId)) next[chatId] = first;
    return next;
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
