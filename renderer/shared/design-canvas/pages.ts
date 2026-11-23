// Page edits on the design canvas: add, rename, duplicate, delete and move.
// Pure and shared, so the page picker and Aiden's tools agree on what each
// edit does. Every function returns `doc` itself when it changes nothing.
// Showing a page is not an edit: it is the chat's view (`view.ts`), so none
// of these change which page anyone looks at.

import { syncConnectors } from "./connectors.js";
import { clampCoord } from "./placement.js";
import {
  DESIGN_CANVAS_LIMITS,
  isDesignContainer,
  type DesignCanvas,
  type DesignComment,
  type DesignConnectorEnd,
  type DesignFrame,
  type DesignPage,
} from "./schema.js";

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

/** Adds an empty page right after the page `after` (at the end when it is left out or gone). */
export function addPage(doc: DesignCanvas, id: string, name?: string, after?: string): DesignCanvas {
  if (!canAddPage(doc) || doc.pages.some((page) => page.id === id)) return doc;
  const page: DesignPage = { id, name: cleanName(name) || nextPageName(doc) };
  const found = after === undefined ? -1 : doc.pages.findIndex((entry) => entry.id === after);
  const at = found < 0 ? doc.pages.length : found + 1;
  return { ...doc, pages: [...doc.pages.slice(0, at), page, ...doc.pages.slice(at)] };
}

/** Renames a page. An empty name is refused. */
export function renamePage(doc: DesignCanvas, id: string, name: string): DesignCanvas {
  const clean = cleanName(name);
  const page = doc.pages.find((entry) => entry.id === id);
  if (!clean || !page || page.name === clean) return doc;
  return { ...doc, pages: doc.pages.map((entry) => (entry.id === id ? { ...entry, name: clean } : entry)) };
}

/**
 * Copies a page and everything on it (groups keep their members) right after
 * it, named "<name> copy". All or nothing: a copy that would pass the page or
 * frame limit returns `doc`.
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
    // An arrow on the page joins the copies of the frames it joined.
    const ends = frame.ends?.map((end): DesignConnectorEnd => {
      const target = end.frameId !== undefined ? ids.get(end.frameId) : undefined;
      return target ? { ...end, frameId: target } : { x: end.x, y: end.y };
    }) as DesignFrame["ends"];
    return { ...rest, id: ids.get(frame.id)!, pageId, ...(groupId ? { groupId } : {}), ...(ends ? { ends } : {}) };
  });
  const page: DesignPage = { id: pageId, name: cleanName(`${source.name} copy`) };
  const at = doc.pages.indexOf(source) + 1;
  return {
    ...doc,
    pages: [...doc.pages.slice(0, at), page, ...doc.pages.slice(at)],
    frames: [...doc.frames, ...copies],
  };
}

/**
 * Deletes a page with its frames and comments, and forgets it as any chat's
 * page. The last page cannot be deleted. A chat looking at it sees the first
 * page instead (`viewPageId`).
 */
export function deletePage(doc: DesignCanvas, id: string): DesignCanvas {
  const at = doc.pages.findIndex((page) => page.id === id);
  if (at < 0 || doc.pages.length <= 1) return doc;
  const pages = doc.pages.filter((page) => page.id !== id);
  const chatPages = Object.fromEntries(Object.entries(doc.chatPages).filter(([, pageId]) => pageId !== id));
  return {
    ...doc,
    pages,
    chatPages,
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
    if (isDesignContainer(frame.kind) && chosen.has(frame.id)) {
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
  // An arrow left behind lets go of the frames that moved away, and one that moved lets go of those left.
  return syncConnectors({ ...doc, frames, comments });
}

/**
 * `source`'s pages appended to `target`, for a chat that brings its canvas
 * along when it joins a workspace. Each source page with a frame on it
 * becomes a new page named "<label> · <page name>"; its frames get new ids,
 * and groups, arrows and comments keep pointing at the copies. Comments keep
 * their ids (a page's `data-aiden-comment` marks name them) unless the target
 * already uses one. `chatPages` is not copied. All or nothing: null when the
 * result would pass the page, frame or comment limit; `target` itself when
 * the source has nothing on it.
 */
export function appendCanvasPages(
  target: DesignCanvas,
  source: DesignCanvas,
  newId: () => string,
  label: string,
): DesignCanvas | null {
  const pages = source.pages.filter((page) => source.frames.some((frame) => frame.pageId === page.id));
  if (pages.length === 0) return target;
  const pageIds = new Map(pages.map((page) => [page.id, newId()]));
  const frames = source.frames.filter((frame) => pageIds.has(frame.pageId));
  const comments = source.comments.filter((comment) => pageIds.has(comment.pageId));
  if (
    target.pages.length + pages.length > DESIGN_CANVAS_LIMITS.pages ||
    target.frames.length + frames.length > DESIGN_CANVAS_LIMITS.frames ||
    target.comments.length + comments.length > DESIGN_CANVAS_LIMITS.comments
  ) {
    return null;
  }
  const frameIds = new Map(frames.map((frame) => [frame.id, newId()]));
  const copies = frames.map((frame): DesignFrame => {
    const groupId = frame.groupId ? frameIds.get(frame.groupId) : undefined;
    const { groupId: _groupId, ...rest } = frame;
    const ends = frame.ends?.map((end): DesignConnectorEnd => {
      const joined = end.frameId !== undefined ? frameIds.get(end.frameId) : undefined;
      return joined ? { ...end, frameId: joined } : { x: end.x, y: end.y };
    }) as DesignFrame["ends"];
    return {
      ...rest,
      id: frameIds.get(frame.id)!,
      pageId: pageIds.get(frame.pageId)!,
      ...(groupId ? { groupId } : {}),
      ...(ends ? { ends } : {}),
    };
  });
  const taken = new Set(target.comments.map((comment) => comment.id));
  const commentCopies = comments.map((comment): DesignComment => {
    const id = taken.has(comment.id) ? newId() : comment.id;
    taken.add(id);
    const frameId = comment.frameId !== undefined ? frameIds.get(comment.frameId) : undefined;
    const { frameId: _frameId, ...rest } = comment;
    return {
      ...rest,
      id,
      pageId: pageIds.get(comment.pageId)!,
      ...(frameId ? { frameId } : {}),
      ...(comment.anchor && frameId ? { anchor: { ...comment.anchor, commentId: id } } : {}),
    };
  });
  const added = pages.map((page): DesignPage => ({ id: pageIds.get(page.id)!, name: cleanName(`${label} · ${page.name}`) }));
  return syncConnectors({
    ...target,
    pages: [...target.pages, ...added],
    frames: [...target.frames, ...copies],
    comments: [...target.comments, ...commentCopies],
  });
}

function cleanName(name: string | undefined): string {
  return (name ?? "").replace(/\s+/gu, " ").trim().slice(0, DESIGN_CANVAS_LIMITS.pageNameChars);
}
