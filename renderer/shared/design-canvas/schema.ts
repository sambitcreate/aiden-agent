// The per-chat design canvas document (version 2) and its parser.
//
// Pure on purpose: the renderer, main and the CLI bundle all import it, so it
// must not touch Node. Every reader goes through `parseDesignCanvas`, which
// clamps boxes, drops frames it cannot trust and reports how many it dropped.
// It also reads version 1 documents (one page, no page ids) and returns them
// as version 2, so the next save writes the new shape.

import { syncConnectors } from "./connectors.js";

export type DesignFrameKind =
  | "file"
  | "artifact"
  | "image"
  | "note"
  | "group"
  | "text"
  | "shape"
  | "connector"
  | "stroke"
  | "frame";
export type DesignWidth = 390 | 768 | 1280 | 1440;

/** The fixed colours a drawn item can use; each follows the theme (`designColorVar`). */
export type DesignColor = "ink" | "gray" | "blue" | "green" | "yellow" | "red" | "purple" | "teal" | "pink";
export const DESIGN_COLORS = [
  "ink",
  "gray",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
  "teal",
  "pink",
] as const satisfies readonly DesignColor[];

export type DesignShapeKind = "rect" | "oval";
export type DesignTextSize = "small" | "medium" | "large";
export type DesignSide = "top" | "right" | "bottom" | "left";

/**
 * One end of an arrow or line. `x` and `y` are where it is, in canvas units.
 * An end on a frame also names the frame (and, optionally, the side it
 * leaves from); it follows the frame, and `x`/`y` keep its last place so the
 * end stays put if the frame goes.
 */
export type DesignConnectorEnd = { x: number; y: number; frameId?: string; side?: DesignSide };

export type DesignFrame = {
  id: string;
  kind: DesignFrameKind;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  groupId?: string;
  designWidth?: DesignWidth;
  /** file, image: workspace-relative. */
  path?: string;
  /** artifact. */
  mediaId?: string;
  /** note and text: the Markdown subset in rich-text.ts; a shape's label: plain words. */
  text?: string;
  /** text and note: how large its type is (medium for text and small for a note when left out). */
  size?: DesignTextSize;
  /** shape. */
  shape?: DesignShapeKind;
  /** shape: its fill (none when left out); note: its colour (the plain card when left out). */
  fill?: DesignColor;
  /** shape outline, connector, stroke, and the words of text and notes. */
  color?: DesignColor;
  /** connector and stroke, and a shape's outline: in canvas units. */
  strokeWidth?: number;
  /** connector: its two ends. */
  ends?: [DesignConnectorEnd, DesignConnectorEnd];
  /** connector: an arrow points at its second end (or both); a line has none. */
  arrow?: "end" | "both";
  /** stroke: points as fractions (0 to 1) of the frame's box, so moving and resizing keep them. */
  points?: [number, number][];
  /** stroke drawn with the pen: each point's curve handle, as a fraction of the box; [0, 0] is a corner. */
  handles?: [number, number][];
  /** stroke drawn with the pen: the path returns to its first point. */
  closed?: true;
  /** The page the frame is on. */
  pageId: string;
  createdBy: "person" | "aiden";
};

/** Kinds other frames can sit in, with `groupId`: a group, or an empty artboard drawn with the Frame tool. */
export function isDesignContainer(kind: DesignFrameKind): boolean {
  return kind === "group" || kind === "frame";
}

/** Kinds drawn as a line, so their box is only where the line is. */
export function isDesignLine(kind: DesignFrameKind): boolean {
  return kind === "connector" || kind === "stroke";
}

/** The smallest box a frame of this kind keeps. Drawn items can be small; pages and notes cannot. */
export function designMinSize(kind: DesignFrameKind): number {
  if (isDesignLine(kind)) return 1;
  if (kind === "text" || kind === "shape") return 8;
  return DESIGN_CANVAS_LIMITS.minSize;
}

/** A box in a page's own CSS pixels, from the top left of its document. */
export type DesignRect = { x: number; y: number; w: number; h: number };

export type DesignCommentAnchor = {
  /** Written into the source as `data-aiden-comment`; the same as the comment's id. */
  commentId: string;
  selector: string;
  text: string;
  tag: string;
  /** The nearest `data-aiden-src` stamp, `file:line`. */
  sourcePath?: string;
  /** Where the element was when last found. */
  rect?: DesignRect;
  /** Where the pin sits, in the page's CSS pixels; it moves with the element. */
  point?: [number, number];
};

export type DesignComment = {
  id: string;
  /** The page the comment is on. */
  pageId: string;
  frameId?: string;
  x: number;
  y: number;
  anchor?: DesignCommentAnchor;
  marks?: { points: [number, number][] }[];
  note: string;
  state: "open" | "sent" | "resolved";
  anchorState: "anchored" | "stale" | "lost";
  createdAt: string;
  /** An open comment waiting in the tray to go to Aiden. */
  queued?: true;
  sentAt?: string;
  resolvedAt?: string;
};

export type DesignViewport = { x: number; y: number; zoom: number };

/** A page of the canvas: its own name and its own place to look at. */
export type DesignPage = { id: string; name: string; viewport: DesignViewport };

export type DesignCanvas = {
  version: 2;
  revision: number;
  /** At least one, in the order the page picker lists them. */
  pages: DesignPage[];
  /** The page on screen; always one of `pages`. */
  activePageId: string;
  frames: DesignFrame[];
  comments: DesignComment[];
};

export const DESIGN_CANVAS_LIMITS = {
  frames: 1000,
  framesPerPage: 400,
  comments: 500,
  pages: 50,
  pageNameChars: 60,
  minSize: 40,
  maxSize: 8000,
  maxCoord: 1_000_000,
  titleChars: 120,
  noteChars: 2000,
  minZoom: 0.1,
  maxZoom: 4,
  strokePoints: 2000,
  minStrokeWidth: 1,
  maxStrokeWidth: 24,
} as const;

export const DESIGN_WIDTHS = [390, 768, 1280, 1440] as const;

const FRAME_KINDS: ReadonlySet<string> = new Set<DesignFrameKind>([
  "file",
  "artifact",
  "image",
  "note",
  "group",
  "text",
  "shape",
  "connector",
  "stroke",
  "frame",
]);
const COLORS: ReadonlySet<string> = new Set(DESIGN_COLORS);
const SIDES: ReadonlySet<string> = new Set<DesignSide>(["top", "right", "bottom", "left"]);
const TEXT_SIZES: ReadonlySet<string> = new Set<DesignTextSize>(["small", "medium", "large"]);
const COMMENT_STATES: ReadonlySet<string> = new Set(["open", "sent", "resolved"]);
const ANCHOR_STATES: ReadonlySet<string> = new Set(["anchored", "stale", "lost"]);
const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 1024;
const MAX_SELECTOR_CHARS = 2000;
const MAX_TAG_CHARS = 64;
const MAX_TIMESTAMP_CHARS = 64;
const MAX_MARKS = 64;
const MAX_MARK_POINTS = 2000;

export type DesignCanvasParseResult =
  | { ok: true; doc: DesignCanvas; dropped: number }
  | { ok: false; issues: string[] };

/** The id of the page a version 1 document becomes, and of a new canvas's first page. */
export const DESIGN_FIRST_PAGE_ID = "page-1";

export function emptyDesignCanvas(): DesignCanvas {
  return {
    version: 2,
    revision: 0,
    pages: [{ id: DESIGN_FIRST_PAGE_ID, name: "Page 1", viewport: { x: 0, y: 0, zoom: 1 } }],
    activePageId: DESIGN_FIRST_PAGE_ID,
    frames: [],
    comments: [],
  };
}

/** The page on screen. */
export function activeDesignPage(doc: DesignCanvas): DesignPage {
  return doc.pages.find((page) => page.id === doc.activePageId) ?? doc.pages[0]!;
}

/** The frames on one page (the page on screen by default), in document order. */
export function framesOnPage(doc: DesignCanvas, pageId: string = doc.activePageId): DesignFrame[] {
  return doc.frames.filter((frame) => frame.pageId === pageId);
}

/** The document with the page on screen looking at `viewport`. */
export function withActiveViewport(doc: DesignCanvas, viewport: DesignViewport): DesignCanvas {
  const page = activeDesignPage(doc);
  if (page.viewport.x === viewport.x && page.viewport.y === viewport.y && page.viewport.zoom === viewport.zoom) {
    return doc;
  }
  return {
    ...doc,
    pages: doc.pages.map((entry) => (entry.id === page.id ? { ...entry, viewport: { ...viewport } } : entry)),
  };
}

/**
 * Lexical check for a workspace-relative path: non-empty, at most 1 024
 * characters, no control characters or backslashes, not absolute, and no
 * empty, `.`/`..` or dot-prefixed (hidden) segment. Containment on disk is
 * the scheme's job; this only rules out what can never be valid.
 */
export function isDesignRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_CHARS)
    return false;
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

export function parseDesignCanvas(value: unknown): DesignCanvasParseResult {
  if (!isRecord(value)) return { ok: false, issues: ["The canvas document is not an object."] };
  const issues: string[] = [];
  if (value.version !== 1 && value.version !== 2) issues.push("The canvas document is not version 1 or 2.");
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    issues.push("The canvas revision is not a non-negative integer.");
  }
  if (!Array.isArray(value.frames)) issues.push("The canvas frames are not a list.");
  if (!Array.isArray(value.comments)) issues.push("The canvas comments are not a list.");
  if (issues.length > 0) return { ok: false, issues };

  let dropped = 0;
  // A version 1 document is one page looking where the document looked.
  const pages =
    value.version === 1
      ? [{ id: DESIGN_FIRST_PAGE_ID, name: "Page 1", viewport: parseViewport(value.viewport) }]
      : parsePages(value.pages);
  const pageIds = new Set(pages.map((page) => page.id));
  const firstPageId = pages[0]!.id;
  const pageOf = (raw: unknown) => {
    const id = isRecord(raw) ? identifier(raw.pageId) : undefined;
    return id && pageIds.has(id) ? id : firstPageId;
  };
  const activePageId =
    typeof value.activePageId === "string" && pageIds.has(value.activePageId) ? value.activePageId : firstPageId;

  const frames: DesignFrame[] = [];
  const frameIds = new Set<string>();
  const perPage = new Map<string, number>();
  for (const raw of value.frames as unknown[]) {
    const pageId = pageOf(raw);
    const room =
      frames.length < DESIGN_CANVAS_LIMITS.frames && (perPage.get(pageId) ?? 0) < DESIGN_CANVAS_LIMITS.framesPerPage;
    const frame = room ? parseFrame(raw, pageId) : null;
    if (!frame || frameIds.has(frame.id)) {
      dropped += 1;
      continue;
    }
    frameIds.add(frame.id);
    perPage.set(pageId, (perPage.get(pageId) ?? 0) + 1);
    frames.push(frame);
  }
  // A frame belongs to a group or artboard on its own page only, and those do not nest.
  const groupPages = new Map(
    frames.filter((frame) => isDesignContainer(frame.kind)).map((frame) => [frame.id, frame.pageId]),
  );
  for (const frame of frames) {
    if (
      frame.groupId !== undefined &&
      (isDesignContainer(frame.kind) || groupPages.get(frame.groupId) !== frame.pageId)
    ) {
      delete frame.groupId;
    }
  }
  const framePages = new Map(frames.map((frame) => [frame.id, frame.pageId]));

  const comments: DesignComment[] = [];
  const commentIds = new Set<string>();
  for (const raw of value.comments as unknown[]) {
    const comment = comments.length < DESIGN_CANVAS_LIMITS.comments ? parseComment(raw, pageOf(raw)) : null;
    if (!comment || commentIds.has(comment.id)) {
      dropped += 1;
      continue;
    }
    if (comment.frameId !== undefined && !frameIds.has(comment.frameId)) delete comment.frameId;
    // A comment on a frame is on that frame's page.
    if (comment.frameId !== undefined) comment.pageId = framePages.get(comment.frameId)!;
    commentIds.add(comment.id);
    comments.push(comment);
  }

  return {
    ok: true,
    // Arrows and lines follow the frames they are on, so a document read back is already up to date.
    doc: syncConnectors({
      version: 2,
      revision: revision as number,
      pages,
      activePageId,
      frames,
      comments,
    }),
    dropped,
  };
}

/** The pages of a version 2 document; never empty, and ids are unique. */
function parsePages(value: unknown): DesignPage[] {
  const pages: DesignPage[] = [];
  const ids = new Set<string>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (pages.length >= DESIGN_CANVAS_LIMITS.pages) break;
      if (!isRecord(raw)) continue;
      const id = identifier(raw.id);
      if (!id || ids.has(id)) continue;
      ids.add(id);
      pages.push({ id, name: pageName(raw.name, pages.length), viewport: parseViewport(raw.viewport) });
    }
  }
  if (pages.length === 0) {
    pages.push({ id: DESIGN_FIRST_PAGE_ID, name: "Page 1", viewport: { x: 0, y: 0, zoom: 1 } });
  }
  return pages;
}

function pageName(value: unknown, index: number): string {
  const name = typeof value === "string" ? value.trim().slice(0, DESIGN_CANVAS_LIMITS.pageNameChars) : "";
  return name || `Page ${index + 1}`;
}

function parseViewport(value: unknown): DesignViewport {
  if (!isRecord(value)) return { x: 0, y: 0, zoom: 1 };
  const zoom = finite(value.zoom);
  return {
    x: clampCoord(finite(value.x) ?? 0),
    y: clampCoord(finite(value.y) ?? 0),
    zoom:
      zoom === undefined
        ? 1
        : clamp(zoom, DESIGN_CANVAS_LIMITS.minZoom, DESIGN_CANVAS_LIMITS.maxZoom),
  };
}

function parseFrame(value: unknown, pageId: string): DesignFrame | null {
  if (!isRecord(value)) return null;
  const id = identifier(value.id);
  const kind = value.kind;
  if (!id || typeof kind !== "string" || !FRAME_KINDS.has(kind)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  const w = finite(value.w);
  const h = finite(value.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  const frame: DesignFrame = {
    id,
    kind: kind as DesignFrameKind,
    title:
      typeof value.title === "string" ? value.title.slice(0, DESIGN_CANVAS_LIMITS.titleChars) : "",
    x: clampCoord(x),
    y: clampCoord(y),
    w: clampSize(w, kind as DesignFrameKind),
    h: clampSize(h, kind as DesignFrameKind),
    pageId,
    createdBy: value.createdBy === "aiden" ? "aiden" : "person",
  };
  const groupId = identifier(value.groupId);
  if (groupId) frame.groupId = groupId;
  if ((DESIGN_WIDTHS as readonly unknown[]).includes(value.designWidth)) {
    frame.designWidth = value.designWidth as DesignWidth;
  }
  if (frame.kind === "file" || frame.kind === "image") {
    if (!isDesignRelativePath(value.path)) return null;
    frame.path = value.path;
  }
  if (frame.kind === "artifact") {
    const mediaId = identifier(value.mediaId);
    if (!mediaId) return null;
    frame.mediaId = mediaId;
  }
  if (frame.kind === "note" || frame.kind === "text") {
    frame.text =
      typeof value.text === "string" ? value.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) : "";
  }
  if ((frame.kind === "text" || frame.kind === "note") && typeof value.size === "string" && TEXT_SIZES.has(value.size)) {
    frame.size = value.size as DesignTextSize;
  }
  if (frame.kind === "shape") {
    if (value.shape !== "rect" && value.shape !== "oval") return null;
    frame.shape = value.shape;
    if (typeof value.text === "string" && value.text) frame.text = value.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars);
    if (isColor(value.fill)) frame.fill = value.fill;
  }
  if (frame.kind === "note" && isColor(value.fill)) frame.fill = value.fill;
  if (frame.kind === "shape" || frame.kind === "text" || frame.kind === "note" || isDesignLine(frame.kind)) {
    if (isColor(value.color)) frame.color = value.color;
  }
  if (frame.kind === "shape" || isDesignLine(frame.kind)) {
    const width = finite(value.strokeWidth);
    if (width !== undefined) {
      frame.strokeWidth = clamp(width, DESIGN_CANVAS_LIMITS.minStrokeWidth, DESIGN_CANVAS_LIMITS.maxStrokeWidth);
    }
  }
  if (frame.kind === "connector") {
    if (!Array.isArray(value.ends) || value.ends.length !== 2) return null;
    const from = parseEnd(value.ends[0]);
    const to = parseEnd(value.ends[1]);
    if (!from || !to) return null;
    frame.ends = [from, to];
    if (value.arrow === "end" || value.arrow === "both") frame.arrow = value.arrow;
  }
  if (frame.kind === "stroke") {
    const points = parseFractions(value.points);
    if (!points || points.length < 2) return null;
    frame.points = points;
    const handles = parseFractions(value.handles, 1);
    if (handles && handles.length === points.length) frame.handles = handles;
    if (value.closed === true && frame.handles) frame.closed = true;
  }
  return frame;
}

function isColor(value: unknown): value is DesignColor {
  return typeof value === "string" && COLORS.has(value);
}

function parseEnd(value: unknown): DesignConnectorEnd | null {
  if (!isRecord(value)) return null;
  const x = finite(value.x);
  const y = finite(value.y);
  if (x === undefined || y === undefined) return null;
  const end: DesignConnectorEnd = { x: clampCoord(x), y: clampCoord(y) };
  const frameId = identifier(value.frameId);
  if (frameId) {
    end.frameId = frameId;
    if (typeof value.side === "string" && SIDES.has(value.side)) end.side = value.side as DesignSide;
  }
  return end;
}

/** Points as fractions of a box: at most `strokePoints` of them, each within `-reach..1 + reach`. */
function parseFractions(value: unknown, reach = 0): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: [number, number][] = [];
  for (const point of value.slice(0, DESIGN_CANVAS_LIMITS.strokePoints)) {
    if (!Array.isArray(point) || point.length !== 2) return undefined;
    const px = finite(point[0]);
    const py = finite(point[1]);
    if (px === undefined || py === undefined) return undefined;
    points.push([clamp(px, -reach, 1 + reach), clamp(py, -reach, 1 + reach)]);
  }
  return points;
}

function parseComment(value: unknown, pageId: string): DesignComment | null {
  if (!isRecord(value)) return null;
  const id = identifier(value.id);
  const x = finite(value.x);
  const y = finite(value.y);
  if (!id || x === undefined || y === undefined) return null;
  if (typeof value.note !== "string") return null;
  if (typeof value.state !== "string" || !COMMENT_STATES.has(value.state)) return null;
  if (typeof value.anchorState !== "string" || !ANCHOR_STATES.has(value.anchorState)) return null;
  if (typeof value.createdAt !== "string" || value.createdAt.length > MAX_TIMESTAMP_CHARS)
    return null;
  const comment: DesignComment = {
    id,
    pageId,
    x: clampCoord(x),
    y: clampCoord(y),
    note: value.note.slice(0, DESIGN_CANVAS_LIMITS.noteChars),
    state: value.state as DesignComment["state"],
    anchorState: value.anchorState as DesignComment["anchorState"],
    createdAt: value.createdAt,
  };
  const frameId = identifier(value.frameId);
  if (frameId) comment.frameId = frameId;
  const anchor = parseAnchor(value.anchor);
  if (anchor) comment.anchor = anchor;
  const marks = parseMarks(value.marks);
  if (marks) comment.marks = marks;
  if (value.queued === true && comment.state === "open") comment.queued = true;
  const sentAt = timestamp(value.sentAt);
  if (sentAt && comment.state !== "open") comment.sentAt = sentAt;
  const resolvedAt = timestamp(value.resolvedAt);
  if (resolvedAt && comment.state === "resolved") comment.resolvedAt = resolvedAt;
  return comment;
}

function parseAnchor(value: unknown): DesignCommentAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const commentId = identifier(value.commentId);
  const { selector, text, tag } = value;
  if (
    !commentId ||
    typeof selector !== "string" ||
    typeof text !== "string" ||
    typeof tag !== "string"
  ) {
    return undefined;
  }
  const anchor: DesignCommentAnchor = {
    commentId,
    selector: selector.slice(0, MAX_SELECTOR_CHARS),
    text: text.slice(0, DESIGN_CANVAS_LIMITS.noteChars),
    tag: tag.slice(0, MAX_TAG_CHARS),
  };
  if (typeof value.sourcePath === "string" && isSourceStamp(value.sourcePath)) anchor.sourcePath = value.sourcePath;
  const rect = parseRect(value.rect);
  if (rect) anchor.rect = rect;
  if (Array.isArray(value.point) && value.point.length === 2) {
    const px = finite(value.point[0]);
    const py = finite(value.point[1]);
    if (px !== undefined && py !== undefined) anchor.point = [clampCoord(px), clampCoord(py)];
  }
  return anchor;
}

function parseRect(value: unknown): DesignRect | undefined {
  if (!isRecord(value)) return undefined;
  const x = finite(value.x);
  const y = finite(value.y);
  const w = finite(value.w);
  const h = finite(value.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x: clampCoord(x), y: clampCoord(y), w: Math.max(0, clampCoord(w)), h: Math.max(0, clampCoord(h)) };
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TIMESTAMP_CHARS ? value : undefined;
}

/** A source stamp: a workspace-relative path with an optional `:line`. */
export function isSourceStamp(value: string): boolean {
  const match = /^(.*?)(?::(\d{1,7}))?$/u.exec(value);
  return Boolean(match && isDesignRelativePath(match[1]));
}

function parseMarks(value: unknown): DesignComment["marks"] {
  if (!Array.isArray(value)) return undefined;
  const marks: { points: [number, number][] }[] = [];
  for (const mark of value.slice(0, MAX_MARKS)) {
    if (!isRecord(mark) || !Array.isArray(mark.points)) continue;
    const points: [number, number][] = [];
    for (const point of mark.points.slice(0, MAX_MARK_POINTS)) {
      if (!Array.isArray(point) || point.length !== 2) continue;
      const px = finite(point[0]);
      const py = finite(point[1]);
      if (px !== undefined && py !== undefined) points.push([clampCoord(px), clampCoord(py)]);
    }
    if (points.length > 0) marks.push({ points });
  }
  return marks.length > 0 ? marks : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS
    ? value
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampCoord(value: number): number {
  return clamp(value, -DESIGN_CANVAS_LIMITS.maxCoord, DESIGN_CANVAS_LIMITS.maxCoord);
}

function clampSize(value: number, kind: DesignFrameKind): number {
  return clamp(value, designMinSize(kind), DESIGN_CANVAS_LIMITS.maxSize);
}
