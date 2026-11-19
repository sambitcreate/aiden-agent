// What Aiden is told about a chat's design canvas: the `canvas_read` answer
// and the one-line summary in the design mode prompt section. Pure, so main
// and tests share it.

import { DESIGN_COMMENT_DATA_NOTE, describeComment } from "./comments.js";
import { activeDesignPage, isDesignContainer, type DesignCanvas, type DesignFrame } from "./schema.js";

/**
 * The part of the canvas a person sees, in canvas units. Main does not know
 * the canvas region's size, so the view is the stored viewport over a
 * typical canvas region of this size, in screen pixels.
 */
export const DESIGN_REFERENCE_VIEW = { w: 1200, h: 800 } as const;

/**
 * At most this many frames are listed one by one per answer, those in view
 * first and then those outside it; the rest are counted, and the answer's
 * `nextCursor` reads the next ones. A page holds at most 400.
 */
export const CANVAS_READ_FRAME_LIMIT = 200;
/** A note's or text item's words are cut to this many characters when it is outside the view. */
const OUTSIDE_TEXT_CHARS = 120;
/** At most this many comments are listed, newest first. */
export const CANVAS_READ_COMMENT_LIMIT = 40;

export type CanvasView = { x: number; y: number; w: number; h: number };

/**
 * Where the next answer of a paged `canvas_read` starts, and the view the
 * first answer sorted by. The frames in view come first, so a later answer
 * keeps that view: if it sorted by the view the person had moved to, a frame
 * could come before the cut in one answer and after it in the next, and be
 * listed twice or not at all.
 */
export type CanvasReadCursor = { offset: number; view: CanvasView };

/** The cursor as the text Aiden passes back, such as `200@-120,40,1200,800`. */
export function formatCanvasReadCursor(cursor: CanvasReadCursor): string {
  const { x, y, w, h } = cursor.view;
  return `${cursor.offset}@${x},${y},${w},${h}`;
}

const CURSOR = /^(\d{1,4})@(-?\d{1,9}),(-?\d{1,9}),(\d{1,9}),(\d{1,9})$/u;

/** The cursor an earlier answer gave, or null when the text is not one. */
export function parseCanvasReadCursor(text: string): CanvasReadCursor | null {
  const match = CURSOR.exec(text.trim());
  if (!match) return null;
  const [offset, x, y, w, h] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (w < 1 || h < 1) return null;
  return { offset, view: { x, y, w, h } };
}

function sameView(a: CanvasView, b: CanvasView): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

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
  /** Locked: it cannot be moved, resized or removed until someone unlocks it. */
  locked?: true;
  guide?: DesignFrame["guide"];
  radius?: number;
  paper?: DesignFrame["paper"];
  printMode?: DesignFrame["printMode"];
  openComments?: number;
};

export type CanvasPageSummary = { id: string; name: string; frames: number; onScreen: boolean };

export type CanvasReadAnswer = {
  units: "canvas";
  /** The page described below. */
  page: { id: string; name: string };
  /** Every page, in order; the person sees the one marked `onScreen`. */
  pages: CanvasPageSummary[];
  /** The view this answer sorts by: the stored one, or for a later answer the one its cursor carries. */
  view: CanvasView;
  /** Present when the person moved the view since the answer whose cursor this one followed. */
  viewMoved?: string;
  frameCount: number;
  openComments: number;
  inView: CanvasFrameSummary[];
  /** Frames outside the view, by group (`"ungrouped"` for the rest). */
  outsideView: { groupId: string; title: string; frames: number }[];
  /** The frames outside the view one by one, within what is left of `CANVAS_READ_FRAME_LIMIT`. */
  outsideFrames: CanvasFrameSummary[];
  /** Frames in view left out of this answer: past `CANVAS_READ_FRAME_LIMIT`, or listed by an earlier answer. */
  omitted: number;
  /** Frames outside the view left out of `outsideFrames`. */
  outsideOmitted: number;
  /** Where this answer's list starts in the page's frames (those in view first); present when not 0. */
  offset?: number;
  /** Pass as `cursor` to read the frames after this answer's; present only when there are more. */
  nextCursor?: string;
  /** Says how many frames this answer lists and how to read the rest; present when it lists fewer than all. */
  more?: string;
  /** The page's open and sent comments, newest first; present when there are any, on the answer from offset 0. */
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
    ...(frame.locked ? { locked: true as const } : {}),
    ...(frame.guide ? { guide: frame.guide } : {}),
    ...(frame.radius !== undefined ? { radius: frame.radius } : {}),
    ...(frame.paper ? { paper: frame.paper } : {}),
    ...(frame.printMode ? { printMode: frame.printMode } : {}),
    ...(openComments > 0 ? { openComments } : {}),
  };
}

function endSummary(end: NonNullable<DesignFrame["ends"]>[number]): { x: number; y: number; frameId?: string } {
  return { x: end.x, y: end.y, ...(end.frameId ? { frameId: end.frameId } : {}) };
}

/**
 * One page of the canvas (the page on screen by default), as `canvas_read`
 * answers: what the stored view shows in detail, then every frame outside
 * it (so Aiden can move, group or focus them) and counts by group.
 */
export function describeCanvas(
  doc: DesignCanvas,
  options: { pageId?: string; view?: CanvasView; cursor?: CanvasReadCursor } = {},
): CanvasReadAnswer {
  const page = doc.pages.find((entry) => entry.id === options.pageId) ?? activeDesignPage(doc);
  const current = options.view ?? canvasView(doc, DESIGN_REFERENCE_VIEW, page.id);
  // A later answer keeps the first answer's view, so the order it cuts is the same.
  const view = options.cursor?.view ?? current;
  const frames = doc.frames.filter((frame) => frame.pageId === page.id);
  const comments = openCommentCounts(doc);
  const visible = frames.filter((frame) => overlaps(frame, view));
  const elsewhere = frames.filter((frame) => !overlaps(frame, view));
  // The frames in view come first, then the rest; the cursor's offset skips that many.
  const start = Math.min(Math.max(0, Math.floor(options.cursor?.offset ?? 0)), frames.length);
  const end = Math.min(frames.length, start + CANVAS_READ_FRAME_LIMIT);
  const listedInView = visible.slice(Math.min(start, visible.length), Math.min(end, visible.length));
  const listedOutside = elsewhere.slice(Math.max(0, start - visible.length), Math.max(0, end - visible.length));
  const paging =
    start === 0 && end === frames.length
      ? {}
      : {
          ...(start > 0 ? { offset: start } : {}),
          ...(end < frames.length ? { nextCursor: formatCanvasReadCursor({ offset: end, view }) } : {}),
          more: `Listed frames ${end > start ? `${start + 1}–${end}` : "none"} of ${frames.length} on this page (those in view first).${
            end < frames.length ? " Pass nextCursor as cursor, with the same page, to read the next ones." : ""
          }`,
        };
  const moved = sameView(view, current)
    ? {}
    : {
        viewMoved:
          "The person has moved the view since the earlier answer. This one keeps that answer's view, so no frame is listed twice or left out; call canvas_read without a cursor to see what is in view now.",
      };
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
    ...moved,
    frameCount: frames.length,
    openComments: doc.comments.filter((comment) => comment.state === "open" && comment.pageId === page.id).length,
    inView: listedInView.map((frame) => summarizeFrame(frame, comments.get(frame.id))),
    outsideView: [...outside.values()],
    outsideFrames: listedOutside.map((frame) => {
      const summary = summarizeFrame(frame, comments.get(frame.id));
      return summary.text && summary.text.length > OUTSIDE_TEXT_CHARS
        ? { ...summary, text: `${summary.text.slice(0, OUTSIDE_TEXT_CHARS)}…` }
        : summary;
    }),
    omitted: visible.length - listedInView.length,
    outsideOmitted: elsewhere.length - listedOutside.length,
    ...paging,
    ...(start === 0 ? commentsOn(doc, page.id) : {}),
  };
}

function commentsOn(doc: DesignCanvas, pageId: string): { comments?: Record<string, unknown>[]; aboutComments?: string } {
  const waiting = doc.comments
    .filter((comment) => comment.pageId === pageId && comment.state !== "resolved")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, CANVAS_READ_COMMENT_LIMIT);
  if (waiting.length === 0) return {};
  return {
    comments: waiting.map((comment) => ({ ...describeComment(doc, comment), state: comment.state })),
    aboutComments: DESIGN_COMMENT_DATA_NOTE,
  };
}

/** The canvas in one line, for the canvas status note (`withCanvasStatusNote`). */
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

/** The transcript section that carries the canvas status note. */
export const CANVAS_STATUS_SECTION = "design-canvas-status";

/**
 * Adds the canvas status to the conversation as a system section patch, only
 * when it differs from the last status the transcript already holds, so a
 * turn where the counts are the same adds nothing. A model that takes system
 * messages mid-conversation reads the note where it sits, and the prompt
 * before it (and the provider's prompt cache) holds. Any other model has the
 * newest note folded into its leading system prompt, so for it a changed
 * count changes the system prompt once, on the turn it changed.
 */
export function withCanvasStatusNote<C extends { messages: readonly unknown[] }>(context: C, line: string, now: number): C {
  const note = `Design canvas when this was noted: ${line}`;
  let last: unknown;
  for (const message of context.messages) {
    const sections = (message as { role?: unknown; sections?: Record<string, unknown> }).sections;
    if ((message as { role?: unknown }).role === "system" && sections && CANVAS_STATUS_SECTION in sections) {
      last = sections[CANVAS_STATUS_SECTION];
    }
  }
  if (last === note) return context;
  return {
    ...context,
    messages: [...context.messages, { role: "system", content: "", sections: { [CANVAS_STATUS_SECTION]: note }, timestamp: now }],
  };
}
