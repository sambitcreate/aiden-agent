// What Aiden is told about a chat's design canvas: the `canvas_read` answer
// and the one-line summary in the design mode prompt section. Pure, so main
// and tests share it.

import { describeComment } from "./comments.js";
import { activeDesignPage, isDesignContainer, type DesignCanvas, type DesignFrame } from "./schema.js";

/**
 * The part of the canvas a person sees, in canvas units. Main does not know
 * the canvas region's size, so the view is the stored viewport over a
 * typical canvas region of this size, in screen pixels.
 */
export const DESIGN_REFERENCE_VIEW = { w: 1200, h: 800 } as const;

/** At most this many frames are listed one by one; the rest are counted. */
export const CANVAS_READ_FRAME_LIMIT = 60;
/** At most this many comments are listed, newest first. */
export const CANVAS_READ_COMMENT_LIMIT = 40;

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
  shape?: DesignFrame["shape"];
  fill?: DesignFrame["fill"];
  color?: DesignFrame["color"];
  size?: DesignFrame["size"];
  /** A connector's ends: where each is, and the frame it is on. */
  from?: { x: number; y: number; frameId?: string };
  to?: { x: number; y: number; frameId?: string };
  arrow?: "none" | "end" | "both";
  /** The person shows this page or artifact with its dark look. */
  dark?: true;
  /** The page's tweak values the person changed, by CSS variable or data attribute. */
  tweaks?: Record<string, string>;
  /** Hidden from the canvas by the person (still on the page). */
  hidden?: true;
  openComments?: number;
};

export type CanvasPageSummary = { id: string; name: string; frames: number; onScreen: boolean };

export type CanvasReadAnswer = {
  units: "canvas";
  /** The page described below. */
  page: { id: string; name: string };
  /** Every page, in order; the person sees the one marked `onScreen`. */
  pages: CanvasPageSummary[];
  view: CanvasView;
  frameCount: number;
  openComments: number;
  inView: CanvasFrameSummary[];
  /** Frames outside the view, by group (`"ungrouped"` for the rest). */
  outsideView: { groupId: string; title: string; frames: number }[];
  /** Listed frames past `CANVAS_READ_FRAME_LIMIT`, left out. */
  omitted: number;
  /** The page's open and sent comments, newest first; present when there are any. */
  comments?: Record<string, unknown>[];
};

/** The canvas area a page's stored viewport shows (the page on screen by default), in canvas units. */
export function canvasView(
  doc: DesignCanvas,
  size: { w: number; h: number } = DESIGN_REFERENCE_VIEW,
  pageId: string = doc.activePageId,
): CanvasView {
  const viewport = (doc.pages.find((page) => page.id === pageId) ?? activeDesignPage(doc)).viewport;
  const zoom = viewport.zoom || 1;
  return {
    x: Math.round(-viewport.x / zoom) + 0,
    y: Math.round(-viewport.y / zoom) + 0,
    w: Math.round(size.w / zoom),
    h: Math.round(size.h / zoom),
  };
}

function overlaps(frame: DesignFrame, view: CanvasView): boolean {
  return frame.x < view.x + view.w && view.x < frame.x + frame.w && frame.y < view.y + view.h && view.y < frame.y + frame.h;
}

function openCommentCounts(doc: DesignCanvas): Map<string, number> {
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
    ...((frame.kind === "note" || frame.kind === "text" || frame.kind === "shape") && frame.text ? { text: frame.text } : {}),
    ...(frame.shape ? { shape: frame.shape } : {}),
    ...(frame.fill ? { fill: frame.fill } : {}),
    ...(frame.color ? { color: frame.color } : {}),
    ...(frame.size ? { size: frame.size } : {}),
    ...(frame.ends
      ? { from: endSummary(frame.ends[0]), to: endSummary(frame.ends[1]), arrow: frame.arrow ?? "none" }
      : {}),
    ...(frame.dark ? { dark: true as const } : {}),
    ...(frame.tweaks ? { tweaks: { ...frame.tweaks } } : {}),
    ...(frame.hidden ? { hidden: true as const } : {}),
    ...(openComments > 0 ? { openComments } : {}),
  };
}

function endSummary(end: NonNullable<DesignFrame["ends"]>[number]): { x: number; y: number; frameId?: string } {
  return { x: end.x, y: end.y, ...(end.frameId ? { frameId: end.frameId } : {}) };
}

/**
 * One page of the canvas (the page on screen by default), as `canvas_read`
 * answers: what the stored view shows in detail and the rest in counts.
 */
export function describeCanvas(
  doc: DesignCanvas,
  options: { pageId?: string; view?: CanvasView } = {},
): CanvasReadAnswer {
  const page = doc.pages.find((entry) => entry.id === options.pageId) ?? activeDesignPage(doc);
  const view = options.view ?? canvasView(doc, DESIGN_REFERENCE_VIEW, page.id);
  const frames = doc.frames.filter((frame) => frame.pageId === page.id);
  const comments = openCommentCounts(doc);
  const visible = frames.filter((frame) => overlaps(frame, view));
  const outside = new Map<string, { groupId: string; title: string; frames: number }>();
  const titles = new Map(frames.filter((frame) => isDesignContainer(frame.kind)).map((frame) => [frame.id, frame.title]));
  for (const frame of frames) {
    if (overlaps(frame, view)) continue;
    const groupId = isDesignContainer(frame.kind) ? frame.id : (frame.groupId ?? "ungrouped");
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
    page: { id: page.id, name: page.name },
    pages: doc.pages.map((entry) => ({
      id: entry.id,
      name: entry.name,
      frames: doc.frames.filter((frame) => frame.pageId === entry.id).length,
      onScreen: entry.id === doc.activePageId,
    })),
    view,
    frameCount: frames.length,
    openComments: doc.comments.filter((comment) => comment.state === "open" && comment.pageId === page.id).length,
    inView: visible.slice(0, CANVAS_READ_FRAME_LIMIT).map((frame) => summarizeFrame(frame, comments.get(frame.id))),
    outsideView: [...outside.values()],
    omitted: Math.max(0, visible.length - CANVAS_READ_FRAME_LIMIT),
    ...commentsOn(doc, page.id),
  };
}

function commentsOn(doc: DesignCanvas, pageId: string): { comments?: Record<string, unknown>[] } {
  const waiting = doc.comments
    .filter((comment) => comment.pageId === pageId && comment.state !== "resolved")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, CANVAS_READ_COMMENT_LIMIT);
  if (waiting.length === 0) return {};
  return { comments: waiting.map((comment) => ({ ...describeComment(doc, comment), state: comment.state })) };
}

/** The canvas in one line, for the design mode prompt section. */
export function canvasPromptLine(doc: DesignCanvas): string {
  const frames = doc.frames.length;
  const open = doc.comments.filter((comment) => comment.state === "open").length;
  const onScreen = activeDesignPage(doc).name;
  const where =
    doc.pages.length > 1 ? ` It has ${doc.pages.length} pages; the person is looking at "${onScreen}".` : "";
  if (frames === 0) return `The canvas is empty.${where}`;
  const files = doc.frames.filter((frame) => frame.kind === "file").length;
  const parts = [`${frames} ${frames === 1 ? "frame" : "frames"}`];
  if (files > 0) parts.push(`${files} HTML ${files === 1 ? "file" : "files"}`);
  parts.push(`${open} open ${open === 1 ? "comment" : "comments"}`);
  return `The canvas has ${parts.join(", ")}.${where}`;
}
