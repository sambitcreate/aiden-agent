// Where arrows and lines go on the design canvas. Pure and shared: the
// renderer draws from it and main's canvas tools and the parser keep stored
// connectors in step with it.
//
// An end on a frame leaves from the middle of one of its sides: the side it
// names, or else the side that faces the other end. Its stored `x`/`y` are
// kept at that place, so when the frame goes the end stays where it was.
//
// Only types come from schema.ts, which imports this module.

import type { DesignCanvas, DesignConnectorEnd, DesignFrame, DesignSide } from "./schema.js";

export type DesignPoint = { x: number; y: number };
export type DesignBox = { x: number; y: number; w: number; h: number };

/** Room around a connector's two ends, for its arrowheads and for a pointer to grab it. */
export const DESIGN_CONNECTOR_PAD = 12;

const LINE_KINDS: ReadonlySet<DesignFrame["kind"]> = new Set(["connector", "stroke"]);
const CONTAINER_KINDS: ReadonlySet<DesignFrame["kind"]> = new Set(["group", "frame"]);

/** A frame an arrow can start or end on: anything but another arrow or a drawn line. */
export function canAttachTo(frame: DesignFrame): boolean {
  return !LINE_KINDS.has(frame.kind);
}

const center = (box: DesignBox): DesignPoint => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** The side of `box` that faces `toward`, measured against the box's own proportions. */
export function facingSide(box: DesignBox, toward: DesignPoint): DesignSide {
  const middle = center(box);
  const dx = (toward.x - middle.x) / Math.max(1, box.w);
  const dy = (toward.y - middle.y) / Math.max(1, box.h);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export function sidePoint(box: DesignBox, side: DesignSide): DesignPoint {
  switch (side) {
    case "top":
      return { x: box.x + box.w / 2, y: box.y };
    case "bottom":
      return { x: box.x + box.w / 2, y: box.y + box.h };
    case "left":
      return { x: box.x, y: box.y + box.h / 2 };
    case "right":
      return { x: box.x + box.w, y: box.y + box.h / 2 };
  }
}

/** The frame an end is on, when it is on one that is still there, on the connector's page. */
function targetOf(
  frames: ReadonlyMap<string, DesignFrame>,
  connector: DesignFrame,
  end: DesignConnectorEnd,
): DesignFrame | undefined {
  if (end.frameId === undefined || end.frameId === connector.id) return undefined;
  const frame = frames.get(end.frameId);
  return frame && frame.pageId === connector.pageId && canAttachTo(frame) ? frame : undefined;
}

/** Both ends of a connector, where they are now, and the box that holds them. */
export function connectorGeometry(
  frames: ReadonlyMap<string, DesignFrame>,
  connector: DesignFrame,
): { ends: [DesignPoint, DesignPoint]; box: DesignBox } {
  const [from, to] = connector.ends ?? [
    { x: connector.x, y: connector.y },
    { x: connector.x + connector.w, y: connector.y + connector.h },
  ];
  const fromFrame = targetOf(frames, connector, from);
  const toFrame = targetOf(frames, connector, to);
  // An end on a frame faces the other end's frame, or the other end itself.
  const aim = (other: DesignConnectorEnd, frame: DesignFrame | undefined) => (frame ? center(frame) : other);
  const place = (end: DesignConnectorEnd, frame: DesignFrame | undefined, other: DesignPoint): DesignPoint =>
    frame ? sidePoint(frame, end.side ?? facingSide(frame, other)) : { x: end.x, y: end.y };
  const a = place(from, fromFrame, aim(to, toFrame));
  const b = place(to, toFrame, aim(from, fromFrame));
  return { ends: [a, b], box: connectorBox(a, b) };
}

/** The box around two ends, with room for arrowheads. */
export function connectorBox(a: DesignPoint, b: DesignPoint): DesignBox {
  const x = Math.round(Math.min(a.x, b.x) - DESIGN_CONNECTOR_PAD);
  const y = Math.round(Math.min(a.y, b.y) - DESIGN_CONNECTOR_PAD);
  return {
    x,
    y,
    w: Math.max(1, Math.round(Math.max(a.x, b.x) + DESIGN_CONNECTOR_PAD) - x),
    h: Math.max(1, Math.round(Math.max(a.y, b.y) + DESIGN_CONNECTOR_PAD) - y),
  };
}

/**
 * Brings every connector up to date with the frames it is on: each end on a
 * frame gets its current place, an end whose frame has gone (or moved to
 * another page) becomes a free end where it last was, and each box holds its
 * ends. Returns `doc` itself when nothing changed.
 */
export function syncConnectors(doc: DesignCanvas): DesignCanvas {
  if (!doc.frames.some((frame) => frame.kind === "connector")) return doc;
  const frames = new Map(doc.frames.map((frame) => [frame.id, frame]));
  let changed = false;
  const next = doc.frames.map((frame) => {
    if (frame.kind !== "connector" || !frame.ends) return frame;
    const { ends, box } = connectorGeometry(frames, frame);
    const synced = frame.ends.map((end, index): DesignConnectorEnd => {
      const point = ends[index]!;
      const kept = targetOf(frames, frame, end) !== undefined;
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      if (kept) {
        if (end.x === x && end.y === y) return end;
        return { ...end, x, y };
      }
      if (end.frameId === undefined && end.x === x && end.y === y) return end;
      return { x, y };
    }) as [DesignConnectorEnd, DesignConnectorEnd];
    const sameEnds = synced[0] === frame.ends[0] && synced[1] === frame.ends[1];
    const sameBox = box.x === frame.x && box.y === frame.y && box.w === frame.w && box.h === frame.h;
    if (sameEnds && sameBox) return frame;
    changed = true;
    return { ...frame, ...box, ends: synced };
  });
  return changed ? { ...doc, frames: next } : doc;
}

const MAX_CONNECTOR_COORD = 1_000_000;
const clampEndCoord = (value: number) =>
  Math.min(MAX_CONNECTOR_COORD, Math.max(-MAX_CONNECTOR_COORD, Math.round(value)));

/** A connector dragged by `dx`, `dy`: its free ends move, and ends on frames stay on them. */
export function translateConnector(frame: DesignFrame, dx: number, dy: number): DesignFrame {
  if (!frame.ends || (dx === 0 && dy === 0)) return frame;
  const ends = frame.ends.map((end) =>
    end.frameId !== undefined ? end : { x: clampEndCoord(end.x + dx), y: clampEndCoord(end.y + dy) },
  ) as [DesignConnectorEnd, DesignConnectorEnd];
  return { ...frame, ends };
}

/**
 * The frame on `pageId` under `point` that an end dropped there attaches
 * to: the topmost one as the canvas draws them (artboards and groups below
 * everything else), never one of `exclude`.
 */
export function attachTargetAt(
  doc: DesignCanvas,
  pageId: string,
  point: DesignPoint,
  exclude: ReadonlySet<string> = new Set(),
): DesignFrame | undefined {
  const onPage = doc.frames.filter((frame) => frame.pageId === pageId && canAttachTo(frame) && !exclude.has(frame.id));
  const drawOrder = [
    ...onPage.filter((frame) => CONTAINER_KINDS.has(frame.kind)),
    ...onPage.filter((frame) => !CONTAINER_KINDS.has(frame.kind)),
  ];
  for (let index = drawOrder.length - 1; index >= 0; index -= 1) {
    const frame = drawOrder[index]!;
    if (point.x >= frame.x && point.x <= frame.x + frame.w && point.y >= frame.y && point.y <= frame.y + frame.h) {
      return frame;
    }
  }
  return undefined;
}
