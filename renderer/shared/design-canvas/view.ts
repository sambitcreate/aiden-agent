// A chat's view of its workspace canvas: the page it looks at, where it looks,
// and how big its canvas is on screen.
//
// The canvas document is shared by every chat of a workspace, so none of
// this is in it. Main keeps each chat's view (`DesignCanvasViews`); the
// renderer reads it on mount and reports changes (`designCanvas:view`), and
// Aiden's tools read it there.
// Panning, zooming and switching pages are view changes: they never save the
// document and are never undo steps. Pure, like `schema.ts`.

import { DESIGN_CANVAS_LIMITS, type DesignCanvas, type DesignViewport } from "./schema.js";

export type DesignChatView = {
  /** The page on screen. It may name a page another chat has since deleted; read it through `viewPageId`. */
  pageId: string;
  viewport: DesignViewport;
  /** The canvas's size on screen, in CSS pixels, when the renderer knows it. */
  size?: { w: number; h: number };
};

/** Where a page is looked at before anyone has moved around it. */
export const DESIGN_FRESH_VIEWPORT: DesignViewport = Object.freeze({ x: 0, y: 0, zoom: 1 });

const MAX_PAGE_ID_CHARS = 128;
const MAX_SIZE = 100_000;

/** The page a view shows: its own when that page still exists, else the first page. */
export function viewPageId(doc: Pick<DesignCanvas, "pages">, view?: { pageId?: string } | null): string {
  const wanted = view?.pageId;
  if (wanted !== undefined && doc.pages.some((page) => page.id === wanted)) return wanted;
  return doc.pages[0]!.id;
}

/**
 * A viewport, with its coordinates and zoom clamped to the canvas's bounds.
 * Null unless `x`, `y` and `zoom` are all finite numbers.
 */
export function parseDesignViewport(value: unknown): DesignViewport | null {
  if (!isRecord(value)) return null;
  const { x, y, zoom } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom)) return null;
  return {
    x: clamp(x, -DESIGN_CANVAS_LIMITS.maxCoord, DESIGN_CANVAS_LIMITS.maxCoord),
    y: clamp(y, -DESIGN_CANVAS_LIMITS.maxCoord, DESIGN_CANVAS_LIMITS.maxCoord),
    zoom: clamp(zoom, DESIGN_CANVAS_LIMITS.minZoom, DESIGN_CANVAS_LIMITS.maxZoom),
  };
}

/** A chat's view as the renderer reports it; null when it names no page or has no usable viewport. */
export function parseDesignChatView(value: unknown): DesignChatView | null {
  if (!isRecord(value)) return null;
  const { pageId } = value;
  if (typeof pageId !== "string" || pageId.length === 0 || pageId.length > MAX_PAGE_ID_CHARS) return null;
  const viewport = parseDesignViewport(value.viewport);
  if (!viewport) return null;
  const view: DesignChatView = { pageId, viewport };
  if (isRecord(value.size)) {
    const { w, h } = value.size;
    if (isFiniteNumber(w) && isFiniteNumber(h) && w > 0 && h > 0) {
      view.size = { w: Math.min(w, MAX_SIZE), h: Math.min(h, MAX_SIZE) };
    }
  }
  return view;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
