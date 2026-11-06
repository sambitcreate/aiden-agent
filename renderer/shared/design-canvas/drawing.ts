// What the drawing tools make: boxes from a drag, pencil and pen strokes as
// frames, and which group or artboard a drawn or moved item sits in. Pure,
// so the canvas and tests share it.

import type { DesignBox, DesignPoint } from "./connectors.js";
import { DESIGN_CANVAS_LIMITS, isDesignContainer, type DesignCanvas, type DesignFrame } from "./schema.js";

/** The box a drag from `a` to `b` draws; `square` keeps it as wide as it is tall. */
export function boxFromDrag(a: DesignPoint, b: DesignPoint, options: { square?: boolean } = {}): DesignBox {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (options.square) w = h = Math.max(w, h);
  return {
    x: Math.round(b.x >= a.x ? a.x : a.x - w),
    y: Math.round(b.y >= a.y ? a.y : a.y - h),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/** An end of a line drawn with Shift held: snapped to the nearest 45° from `a`. */
export function snapAngle(a: DesignPoint, b: DesignPoint): DesignPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return b;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length };
}

function distanceToSegment(p: DesignPoint, a: DesignPoint, b: DesignPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker: drops points that stay within `tolerance` of the line kept. */
function simplifyOnce(points: readonly DesignPoint[], tolerance: number): DesignPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const d = distanceToSegment(points[index]!, points[first]!, points[last]!);
      if (d > distance) {
        distance = d;
        farthest = index;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/**
 * A pencil line with the jitter taken out: points within `tolerance` canvas
 * units of the line are dropped, and the tolerance grows until at most
 * `strokePoints` are left.
 */
export function simplifyStroke(points: readonly DesignPoint[], tolerance = 1): DesignPoint[] {
  const distinct = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y,
  );
  let kept = simplifyOnce(distinct, tolerance);
  for (let wider = tolerance * 2; kept.length > DESIGN_CANVAS_LIMITS.strokePoints; wider *= 2) {
    kept = simplifyOnce(distinct, wider);
  }
  return kept;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * A stroke's box and its points as fractions of that box. The box leaves
 * room for the line's width; `handles` (pen curve handles, in canvas units
 * from their point) count towards it too.
 */
export function strokeFromCanvas(
  points: readonly DesignPoint[],
  strokeWidth: number,
  handles?: readonly DesignPoint[],
): Pick<DesignFrame, "x" | "y" | "w" | "h" | "points" | "handles"> | null {
  if (points.length < 2) return null;
  const reach = [...points];
  if (handles) {
    points.forEach((point, index) => {
      const handle = handles[index]!;
      reach.push({ x: point.x + handle.x, y: point.y + handle.y }, { x: point.x - handle.x, y: point.y - handle.y });
    });
  }
  const pad = strokeWidth / 2 + 2;
  const minX = Math.min(...reach.map((point) => point.x)) - pad;
  const minY = Math.min(...reach.map((point) => point.y)) - pad;
  const maxX = Math.max(...reach.map((point) => point.x)) + pad;
  const maxY = Math.max(...reach.map((point) => point.y)) + pad;
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  const w = Math.max(1, Math.ceil(maxX) - x);
  const h = Math.max(1, Math.ceil(maxY) - y);
  if (w > DESIGN_CANVAS_LIMITS.maxSize || h > DESIGN_CANVAS_LIMITS.maxSize) return null;
  return {
    x,
    y,
    w,
    h,
    points: points.map((point) => [round4((point.x - x) / w), round4((point.y - y) / h)]),
    ...(handles ? { handles: handles.map((handle) => [round4(handle.x / w), round4(handle.y / h)]) } : {}),
  };
}

/** A stroke's points back in canvas units, within its current box. */
export function strokeOnCanvas(frame: DesignFrame): { points: DesignPoint[]; handles?: DesignPoint[] } {
  const points = (frame.points ?? []).map(([px, py]) => ({ x: frame.x + px * frame.w, y: frame.y + py * frame.h }));
  return frame.handles
    ? { points, handles: frame.handles.map(([hx, hy]) => ({ x: hx * frame.w, y: hy * frame.h })) }
    : { points };
}

/**
 * The SVG path of a stroke, in the frame's own units (0,0 at its top left).
 * A pencil line is smoothed through the midpoints of its points; a pen path
 * follows its curve handles.
 */
export function strokePath(frame: Pick<DesignFrame, "w" | "h" | "points" | "handles" | "closed">): string {
  const points = (frame.points ?? []).map(([px, py]) => [px * frame.w, py * frame.h] as const);
  if (points.length < 2) return "";
  const fmt = (value: number) => Math.round(value * 100) / 100;
  if (frame.handles) {
    const handles = frame.handles.map(([hx, hy]) => [hx * frame.w, hy * frame.h] as const);
    const segment = (from: number, to: number) => {
      const [ax, ay] = points[from]!;
      const [bx, by] = points[to]!;
      const [hax, hay] = handles[from]!;
      const [hbx, hby] = handles[to]!;
      return ` C${fmt(ax + hax)},${fmt(ay + hay)} ${fmt(bx - hbx)},${fmt(by - hby)} ${fmt(bx)},${fmt(by)}`;
    };
    let d = `M${fmt(points[0]![0])},${fmt(points[0]![1])}`;
    for (let index = 1; index < points.length; index += 1) d += segment(index - 1, index);
    if (frame.closed) d += `${segment(points.length - 1, 0)} Z`;
    return d;
  }
  let d = `M${fmt(points[0]![0])},${fmt(points[0]![1])}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [x, y] = points[index]!;
    const [nx, ny] = points[index + 1]!;
    d += ` Q${fmt(x)},${fmt(y)} ${fmt((x + nx) / 2)},${fmt((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1]!;
  return `${d} L${fmt(lx)},${fmt(ly)}`;
}

/**
 * The group or artboard on `pageId` that holds a box: the topmost one its
 * centre is inside. Groups and artboards themselves sit in nothing.
 */
export function containerAt(
  doc: DesignCanvas,
  pageId: string,
  box: DesignBox,
  exclude?: string,
): DesignFrame | undefined {
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  const containers = doc.frames.filter(
    (frame) => frame.pageId === pageId && isDesignContainer(frame.kind) && frame.id !== exclude,
  );
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    const frame = containers[index]!;
    if (x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h) return frame;
  }
  return undefined;
}

/**
 * After a drag: each moved item joins the group or artboard it was dropped
 * in, or leaves the one it was dragged out of. Returns `doc` itself when no
 * membership changed.
 */
export function regroupFrames(doc: DesignCanvas, ids: Iterable<string>): DesignCanvas {
  const moved = new Set(ids);
  let changed = false;
  const frames = doc.frames.map((frame) => {
    if (!moved.has(frame.id) || isDesignContainer(frame.kind)) return frame;
    // An item moved together with its group stays in it.
    if (frame.groupId !== undefined && moved.has(frame.groupId)) return frame;
    const container = containerAt(doc, frame.pageId, frame)?.id;
    if (container === frame.groupId) return frame;
    changed = true;
    const { groupId: _groupId, ...rest } = frame;
    return container ? { ...rest, groupId: container } : rest;
  });
  return changed ? { ...doc, frames } : doc;
}
