// What Aiden is told about a chat's design canvas: the `canvas_read` answer
// and the one-line summary in the design mode prompt section. Pure, so main
// and tests share it.

import type { DesignCanvasV1, DesignFrame } from "./schema.js";

/**
 * The part of the canvas a person sees, in canvas units. Main does not know
 * the canvas region's size, so the view is the stored viewport over a
 * typical canvas region of this size, in screen pixels.
 */
export const DESIGN_REFERENCE_VIEW = { w: 1200, h: 800 } as const;

/** At most this many frames are listed one by one; the rest are counted. */
export const CANVAS_READ_FRAME_LIMIT = 60;

export type CanvasView = { x: number; y: number; w: number; h: number };

export type CanvasFrameSummary = {
  id: string;
  kind: DesignFrame["kind"];
  title: string;
  box: { x: number; y: number; w: number; h: number };
  createdBy: DesignFrame["createdBy"];
  path?: string;
  groupId?: string;
  designWidth?: number;
  text?: string;
  openComments?: number;
};

export type CanvasReadAnswer = {
  units: "canvas";
  view: CanvasView;
  frameCount: number;
  openComments: number;
  inView: CanvasFrameSummary[];
  /** Frames outside the view, by group (`"ungrouped"` for the rest). */
  outsideView: { groupId: string; title: string; frames: number }[];
  /** Listed frames past `CANVAS_READ_FRAME_LIMIT`, left out. */
  omitted: number;
};

/** The canvas area the stored viewport shows, in canvas units. */
export function canvasView(doc: DesignCanvasV1, size: { w: number; h: number } = DESIGN_REFERENCE_VIEW): CanvasView {
  const zoom = doc.viewport.zoom || 1;
  return {
    x: Math.round(-doc.viewport.x / zoom) + 0,
    y: Math.round(-doc.viewport.y / zoom) + 0,
    w: Math.round(size.w / zoom),
    h: Math.round(size.h / zoom),
  };
}

function overlaps(frame: DesignFrame, view: CanvasView): boolean {
  return frame.x < view.x + view.w && view.x < frame.x + frame.w && frame.y < view.y + view.h && view.y < frame.y + frame.h;
}

function openCommentCounts(doc: DesignCanvasV1): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of doc.comments) {
    if (comment.state !== "open" || !comment.frameId) continue;
    counts.set(comment.frameId, (counts.get(comment.frameId) ?? 0) + 1);
  }
  return counts;
}

export function summarizeFrame(frame: DesignFrame, openComments = 0): CanvasFrameSummary {
  return {
    id: frame.id,
    kind: frame.kind,
    title: frame.title,
    box: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
    createdBy: frame.createdBy,
    ...(frame.path !== undefined ? { path: frame.path } : {}),
    ...(frame.groupId !== undefined ? { groupId: frame.groupId } : {}),
    ...(frame.designWidth !== undefined ? { designWidth: frame.designWidth } : {}),
    ...(frame.kind === "note" && frame.text ? { text: frame.text } : {}),
    ...(openComments > 0 ? { openComments } : {}),
  };
}

export function describeCanvas(doc: DesignCanvasV1, view: CanvasView = canvasView(doc)): CanvasReadAnswer {
  const comments = openCommentCounts(doc);
  const visible = doc.frames.filter((frame) => overlaps(frame, view));
  const outside = new Map<string, { groupId: string; title: string; frames: number }>();
  const titles = new Map(doc.frames.filter((frame) => frame.kind === "group").map((frame) => [frame.id, frame.title]));
  for (const frame of doc.frames) {
    if (overlaps(frame, view)) continue;
    const groupId = frame.kind === "group" ? frame.id : (frame.groupId ?? "ungrouped");
    const entry = outside.get(groupId) ?? {
      groupId,
      title: groupId === "ungrouped" ? "Not in a group" : (titles.get(groupId) ?? "Group"),
      frames: 0,
    };
    entry.frames += 1;
    outside.set(groupId, entry);
  }
  return {
    units: "canvas",
    view,
    frameCount: doc.frames.length,
    openComments: doc.comments.filter((comment) => comment.state === "open").length,
    inView: visible.slice(0, CANVAS_READ_FRAME_LIMIT).map((frame) => summarizeFrame(frame, comments.get(frame.id))),
    outsideView: [...outside.values()],
    omitted: Math.max(0, visible.length - CANVAS_READ_FRAME_LIMIT),
  };
}

/** The canvas in one line, for the design mode prompt section. */
export function canvasPromptLine(doc: DesignCanvasV1): string {
  const frames = doc.frames.length;
  const open = doc.comments.filter((comment) => comment.state === "open").length;
  if (frames === 0) return "The canvas is empty.";
  const pages = doc.frames.filter((frame) => frame.kind === "file").length;
  const parts = [`${frames} ${frames === 1 ? "frame" : "frames"}`];
  if (pages > 0) parts.push(`${pages} ${pages === 1 ? "page" : "pages"}`);
  parts.push(`${open} open ${open === 1 ? "comment" : "comments"}`);
  return `The canvas has ${parts.join(", ")}.`;
}
