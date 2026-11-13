// The layer order of a canvas page: the page's frames in the order they are
// drawn, front-most first, with a group's or artboard's members listed under
// it. Pure and shared, so the side panel's layer list and Aiden's canvas
// tools reorder layers the same way.
//
// The canvas draws groups and artboards first (in document order), then
// everything else (in document order), so a container is always behind the
// items in it. Reordering keeps that: an item only trades places with its
// siblings, the items with the same parent that are drawn in the same pass.

import { isDesignContainer, type DesignCanvas, type DesignFrame } from "./schema.js";

export type DesignLayer = { frame: DesignFrame; children: DesignLayer[] };

/** Where a dragged layer lands: in front of the target (above it in the list) or behind it. */
export type DesignLayerPlace = "above" | "below";

function onPage(doc: DesignCanvas, pageId: string): DesignFrame[] {
  return doc.frames.filter((frame) => frame.pageId === pageId);
}

/** The frames in the order the canvas draws them, back to front. */
function drawOrder(frames: readonly DesignFrame[]): DesignFrame[] {
  return [...frames.filter((frame) => isDesignContainer(frame.kind)), ...frames.filter((frame) => !isDesignContainer(frame.kind))];
}

/** The parent a frame is listed under: its group or artboard on this page, or none. */
function parentOf(frame: DesignFrame, byId: ReadonlyMap<string, DesignFrame>): string | null {
  const parent = frame.groupId ? byId.get(frame.groupId) : undefined;
  return parent && parent.id !== frame.id && isDesignContainer(parent.kind) ? parent.id : null;
}

/** The layer tree of the page on screen, front-most first. */
export function designLayers(doc: DesignCanvas): DesignLayer[] {
  const frames = onPage(doc, doc.activePageId);
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const front = drawOrder(frames).reverse();
  const childrenOf = (parent: string | null, seen: ReadonlySet<string>): DesignLayer[] =>
    front
      .filter((frame) => parentOf(frame, byId) === parent && !seen.has(frame.id))
      .map((frame) => ({ frame, children: childrenOf(frame.id, new Set([...seen, frame.id])) }));
  return childrenOf(null, new Set());
}

/** The frames that trade places with `frame` on its own page, back to front. */
function siblings(doc: DesignCanvas, frame: DesignFrame): DesignFrame[] {
  const frames = onPage(doc, frame.pageId);
  const byId = new Map(frames.map((entry) => [entry.id, entry]));
  const parent = parentOf(frame, byId);
  const container = isDesignContainer(frame.kind);
  return drawOrder(frames).filter(
    (entry) => parentOf(entry, byId) === parent && isDesignContainer(entry.kind) === container,
  );
}

/**
 * Moves `id` just in front of `targetId` ("above" it in the list) or just
 * behind it. Only siblings trade places; anything else returns `doc` as it was.
 */
export function reorderLayer(doc: DesignCanvas, id: string, targetId: string, place: DesignLayerPlace): DesignCanvas {
  if (id === targetId) return doc;
  const frame = doc.frames.find((entry) => entry.id === id);
  const target = doc.frames.find((entry) => entry.id === targetId);
  if (!frame || !target || frame.pageId !== target.pageId) return doc;
  if (!siblings(doc, frame).some((entry) => entry.id === targetId)) return doc;
  const rest = doc.frames.filter((entry) => entry.id !== id);
  const at = rest.findIndex((entry) => entry.id === targetId);
  const frames = [...rest.slice(0, place === "above" ? at + 1 : at), frame, ...rest.slice(place === "above" ? at + 1 : at)];
  return frames.every((entry, index) => entry === doc.frames[index]) ? doc : { ...doc, frames };
}

/** Brings `id` one step forward (up the list) or sends it one step back. */
export function stepLayer(doc: DesignCanvas, id: string, direction: "forward" | "backward"): DesignCanvas {
  const frame = doc.frames.find((entry) => entry.id === id);
  if (!frame) return doc;
  const order = siblings(doc, frame);
  const index = order.findIndex((entry) => entry.id === id);
  const neighbour = order[direction === "forward" ? index + 1 : index - 1];
  return neighbour ? reorderLayer(doc, id, neighbour.id, direction === "forward" ? "above" : "below") : doc;
}

/** Brings `id` in front of all its siblings. */
export function bringLayerToFront(doc: DesignCanvas, id: string): DesignCanvas {
  const frame = doc.frames.find((entry) => entry.id === id);
  if (!frame) return doc;
  const order = siblings(doc, frame);
  const front = order[order.length - 1];
  return front ? reorderLayer(doc, id, front.id, "above") : doc;
}

/** Sends `id` behind all its siblings. */
export function sendLayerToBack(doc: DesignCanvas, id: string): DesignCanvas {
  const frame = doc.frames.find((entry) => entry.id === id);
  if (!frame) return doc;
  const back = siblings(doc, frame)[0];
  return back ? reorderLayer(doc, id, back.id, "below") : doc;
}
