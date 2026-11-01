// The per-chat design canvas document (version 1) and its parser.
//
// Pure on purpose: the renderer, main and the CLI bundle all import it, so it
// must not touch Node. Every reader goes through `parseDesignCanvasV1`, which
// clamps boxes, drops frames it cannot trust and reports how many it dropped.

export type DesignFrameKind = "file" | "artifact" | "image" | "note" | "group";
export type DesignWidth = 390 | 768 | 1280 | 1440;

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
  /** note. */
  text?: string;
  createdBy: "person" | "aiden";
};

export type DesignCommentAnchor = {
  commentId: string;
  selector: string;
  text: string;
  tag: string;
  sourcePath?: string;
};

export type DesignComment = {
  id: string;
  frameId?: string;
  x: number;
  y: number;
  anchor?: DesignCommentAnchor;
  marks?: { points: [number, number][] }[];
  note: string;
  state: "open" | "sent" | "resolved";
  anchorState: "anchored" | "stale" | "lost";
  createdAt: string;
};

export type DesignCanvasV1 = {
  version: 1;
  revision: number;
  viewport: { x: number; y: number; zoom: number };
  frames: DesignFrame[];
  comments: DesignComment[];
};

export const DESIGN_CANVAS_LIMITS = {
  frames: 200,
  comments: 500,
  minSize: 40,
  maxSize: 8000,
  maxCoord: 1_000_000,
  titleChars: 120,
  noteChars: 2000,
  minZoom: 0.1,
  maxZoom: 4,
} as const;

export const DESIGN_WIDTHS = [390, 768, 1280, 1440] as const;

const FRAME_KINDS: ReadonlySet<string> = new Set<DesignFrameKind>([
  "file",
  "artifact",
  "image",
  "note",
  "group",
]);
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
  | { ok: true; doc: DesignCanvasV1; dropped: number }
  | { ok: false; issues: string[] };

export function emptyDesignCanvas(): DesignCanvasV1 {
  return { version: 1, revision: 0, viewport: { x: 0, y: 0, zoom: 1 }, frames: [], comments: [] };
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

export function parseDesignCanvasV1(value: unknown): DesignCanvasParseResult {
  if (!isRecord(value)) return { ok: false, issues: ["The canvas document is not an object."] };
  const issues: string[] = [];
  if (value.version !== 1) issues.push("The canvas document is not version 1.");
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    issues.push("The canvas revision is not a non-negative integer.");
  }
  if (!Array.isArray(value.frames)) issues.push("The canvas frames are not a list.");
  if (!Array.isArray(value.comments)) issues.push("The canvas comments are not a list.");
  if (issues.length > 0) return { ok: false, issues };

  let dropped = 0;
  const frames: DesignFrame[] = [];
  const frameIds = new Set<string>();
  for (const raw of value.frames as unknown[]) {
    const frame = frames.length < DESIGN_CANVAS_LIMITS.frames ? parseFrame(raw) : null;
    if (!frame || frameIds.has(frame.id)) {
      dropped += 1;
      continue;
    }
    frameIds.add(frame.id);
    frames.push(frame);
  }
  const groupIds = new Set(
    frames.filter((frame) => frame.kind === "group").map((frame) => frame.id),
  );
  for (const frame of frames) {
    if (frame.groupId !== undefined && (frame.kind === "group" || !groupIds.has(frame.groupId))) {
      delete frame.groupId;
    }
  }

  const comments: DesignComment[] = [];
  const commentIds = new Set<string>();
  for (const raw of value.comments as unknown[]) {
    const comment = comments.length < DESIGN_CANVAS_LIMITS.comments ? parseComment(raw) : null;
    if (!comment || commentIds.has(comment.id)) {
      dropped += 1;
      continue;
    }
    if (comment.frameId !== undefined && !frameIds.has(comment.frameId)) delete comment.frameId;
    commentIds.add(comment.id);
    comments.push(comment);
  }

  return {
    ok: true,
    doc: {
      version: 1,
      revision: revision as number,
      viewport: parseViewport(value.viewport),
      frames,
      comments,
    },
    dropped,
  };
}

function parseViewport(value: unknown): DesignCanvasV1["viewport"] {
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

function parseFrame(value: unknown): DesignFrame | null {
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
    w: clampSize(w),
    h: clampSize(h),
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
  if (frame.kind === "note") {
    frame.text =
      typeof value.text === "string" ? value.text.slice(0, DESIGN_CANVAS_LIMITS.noteChars) : "";
  }
  return frame;
}

function parseComment(value: unknown): DesignComment | null {
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
  if (isDesignRelativePath(value.sourcePath)) anchor.sourcePath = value.sourcePath;
  return anchor;
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

function clampSize(value: number): number {
  return clamp(value, DESIGN_CANVAS_LIMITS.minSize, DESIGN_CANVAS_LIMITS.maxSize);
}
