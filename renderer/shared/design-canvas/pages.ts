// Page edits on the design canvas: add, rename, duplicate, delete, move and
// show. Pure and shared, so the page picker and Aiden's tools agree on what
// each edit does. Every function returns `doc` itself when it changes nothing.

import { clampCoord } from "./placement.js";
import { DESIGN_CANVAS_LIMITS, type DesignCanvas, type DesignFrame, type DesignPage } from "./schema.js";

const FRESH_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

/** "Page N" for the lowest N no page is called yet. */
export function nextPageName(doc: DesignCanvas): string {
  const taken = new Set(doc.pages.map((page) => page.name.toLocaleLowerCase()));
  for (let index = doc.pages.length + 1; ; index += 1) {
    const name = `Page ${index}`;
    if (!taken.has(name.toLocaleLowerCase())) return name;
  }
}

export function canAddPage(doc: DesignCanvas): boolean {
  return doc.pages.length < DESIGN_CANVAS_LIMITS.pages;
}

/** Adds an empty page after the one on screen and shows it. */
export function addPage(doc: DesignCanvas, id: string, name?: string): DesignCanvas {
  if (!canAddPage(doc) || doc.pages.some((page) => page.id === id)) return doc;
  const page: DesignPage = { id, name: cleanName(name) || nextPageName(doc), viewport: { ...FRESH_VIEWPORT } };
  const at = doc.pages.findIndex((entry) => entry.id === doc.activePageId) + 1;
  return { ...doc, pages: [...doc.pages.slice(0, at), page, ...doc.pages.slice(at)], activePageId: id };
}

/** Renames a page. An empty name is refused. */
export function renamePage(doc: DesignCanvas, id: string, name: string): DesignCanvas {
  const clean = cleanName(name);
  const page = doc.pages.find((entry) => entry.id === id);
  if (!clean || !page || page.name === clean) return doc;
  return { ...doc, pages: doc.pages.map((entry) => (entry.id === id ? { ...entry, name: clean } : entry)) };
}

/** Shows a page. */
export function showPage(doc: DesignCanvas, id: string): DesignCanvas {
  if (doc.activePageId === id || !doc.pages.some((page) => page.id === id)) return doc;
  return { ...doc, activePageId: id };
}

/**
 * Copies a page and everything on it (groups keep their members) right after
 * it, named "<name> copy", and shows the copy. All or nothing: a copy that
 * would pass the page or frame limit returns `doc`.
 */
export function duplicatePage(doc: DesignCanvas, id: string, pageId: string, newFrameId: () => string): DesignCanvas {
  const source = doc.pages.find((page) => page.id === id);
  if (!source || !canAddPage(doc) || doc.pages.some((page) => page.id === pageId)) return doc;
  const frames = doc.frames.filter((frame) => frame.pageId === id);
  if (doc.frames.length + frames.length > DESIGN_CANVAS_LIMITS.frames) return doc;
  const ids = new Map(frames.map((frame) => [frame.id, newFrameId()]));
  const copies = frames.map((frame): DesignFrame => {
    const groupId = frame.groupId ? ids.get(frame.groupId) : undefined;
    const { groupId: _groupId, ...rest } = frame;
    return { ...rest, id: ids.get(frame.id)!, pageId, ...(groupId ? { groupId } : {}) };
  });
  const page: DesignPage = {
    id: pageId,
    name: cleanName(`${source.name} copy`),
    viewport: { ...source.viewport },
  };
  const at = doc.pages.indexOf(source) + 1;
  return {
    ...doc,
    pages: [...doc.pages.slice(0, at), page, ...doc.pages.slice(at)],
    activePageId: pageId,
    frames: [...doc.frames, ...copies],
  };
}

/**
 * Deletes a page with its frames and comments. The last page cannot be
 * deleted. If it was on screen, the page before it (or the new first page)
 * is shown instead.
 */
export function deletePage(doc: DesignCanvas, id: string): DesignCanvas {
  const at = doc.pages.findIndex((page) => page.id === id);
  if (at < 0 || doc.pages.length <= 1) return doc;
  const pages = doc.pages.filter((page) => page.id !== id);
  const activePageId = doc.activePageId === id ? pages[Math.max(0, at - 1)]!.id : doc.activePageId;
  return {
    ...doc,
    pages,
    activePageId,
    frames: doc.frames.filter((frame) => frame.pageId !== id),
    comments: doc.comments.filter((comment) => comment.pageId !== id),
  };
}

/** Moves a page one place earlier (-1) or later (+1) in the list. */
export function movePage(doc: DesignCanvas, id: string, step: -1 | 1): DesignCanvas {
  const at = doc.pages.findIndex((page) => page.id === id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= doc.pages.length) return doc;
  const pages = [...doc.pages];
  [pages[at], pages[to]] = [pages[to]!, pages[at]!];
  return { ...doc, pages };
}

/**
 * Moves frames to another page, keeping their boxes. A group brings its
 * members; a member moved without its group leaves the group. Comments on a
 * moved frame go with it.
 */
export function moveFramesToPage(doc: DesignCanvas, ids: readonly string[], pageId: string): DesignCanvas {
  if (!doc.pages.some((page) => page.id === pageId)) return doc;
  const chosen = new Set(ids);
  for (const frame of doc.frames) {
    if (frame.kind === "group" && chosen.has(frame.id)) {
      for (const member of doc.frames) if (member.groupId === frame.id) chosen.add(member.id);
    }
  }
  let changed = false;
  const frames = doc.frames.map((frame) => {
    if (!chosen.has(frame.id) || frame.pageId === pageId) return frame;
    changed = true;
    const keepsGroup = frame.groupId !== undefined && chosen.has(frame.groupId);
    const { groupId: _groupId, ...rest } = frame;
    return { ...rest, pageId, x: clampCoord(frame.x), y: clampCoord(frame.y), ...(keepsGroup ? { groupId: frame.groupId } : {}) };
  });
  if (!changed) return doc;
  const comments = doc.comments.map((comment) =>
    comment.frameId !== undefined && chosen.has(comment.frameId) && comment.pageId !== pageId ? { ...comment, pageId } : comment,
  );
  return { ...doc, frames, comments };
}

function cleanName(name: string | undefined): string {
  return (name ?? "").replace(/\s+/gu, " ").trim().slice(0, DESIGN_CANVAS_LIMITS.pageNameChars);
}
