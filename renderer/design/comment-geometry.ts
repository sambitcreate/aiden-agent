// Where comment pins sit on the design canvas, in canvas units. Pure, so the
// pins layer and tests share it.

import type { DesignCanvas, DesignComment, DesignFrame } from "../shared/design-canvas/schema";
import { DESIGN_DEFAULT_WIDTH, DESIGN_FRAME_HEADER_PX } from "./nodes/design-node-context";

export type FrameScroll = { x: number; y: number };

export type PinPlace = {
  x: number;
  y: number;
  /** The pin's element is scrolled out of its frame. */
  hidden: boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A pin's place on the canvas. A pin on a page's element follows the element
 * inside its frame, scaled to the frame and moved by how far the page is
 * scrolled; a pin on a frame stays at its spot on the frame; a free pin stays
 * where it was dropped.
 */
export function pinPlace(
  doc: DesignCanvas,
  comment: DesignComment,
  scroll: ReadonlyMap<string, FrameScroll> = new Map(),
): PinPlace {
  const frame = comment.frameId ? doc.frames.find((entry) => entry.id === comment.frameId) : undefined;
  if (!frame) return { x: comment.x, y: comment.y, hidden: false };
  if (frame.kind === "file" && comment.anchor?.point) {
    const scale = frame.w / (frame.designWidth ?? DESIGN_DEFAULT_WIDTH);
    const offset = scroll.get(frame.id) ?? { x: 0, y: 0 };
    const x = frame.x + (comment.anchor.point[0] - offset.x) * scale;
    const y = frame.y + DESIGN_FRAME_HEADER_PX + (comment.anchor.point[1] - offset.y) * scale;
    const hidden = x < frame.x || x > frame.x + frame.w || y < frame.y + DESIGN_FRAME_HEADER_PX || y > frame.y + frame.h;
    return { x, y, hidden };
  }
  return { x: frame.x + clamp(comment.x, 0, frame.w), y: frame.y + clamp(comment.y, 0, frame.h), hidden: false };
}

/** Each comment's number on its page, oldest first, as its pin shows it. */
export function commentNumbers(doc: DesignCanvas): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  const counts = new Map<string, number>();
  const ordered = [...doc.comments].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const comment of ordered) {
    const next = (counts.get(comment.pageId) ?? 0) + 1;
    counts.set(comment.pageId, next);
    numbers.set(comment.id, next);
  }
  return numbers;
}

type Stroke = [number, number][];

/** Marks as stored: fractions of the frame's box for a comment on a frame, canvas units otherwise. */
export function marksFromCanvas(frame: DesignFrame | undefined, strokes: readonly Stroke[]): DesignComment["marks"] {
  const kept = strokes.filter((stroke) => stroke.length > 1);
  if (kept.length === 0) return undefined;
  if (!frame || frame.w <= 0 || frame.h <= 0) return kept.map((points) => ({ points: points.map(([x, y]) => [x, y]) }));
  return kept.map((points) => ({
    points: points.map(([x, y]) => [(x - frame.x) / frame.w, (y - frame.y) / frame.h] as [number, number]),
  }));
}

/** Stored marks back in canvas units, following the frame where it is now. */
export function marksOnCanvas(frame: DesignFrame | undefined, marks: DesignComment["marks"]): Stroke[] {
  if (!marks) return [];
  if (!frame) return marks.map((mark) => mark.points.map(([x, y]) => [x, y]));
  return marks.map((mark) => mark.points.map(([x, y]) => [frame.x + x * frame.w, frame.y + y * frame.h]));
}
