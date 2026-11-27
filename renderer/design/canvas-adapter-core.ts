// The design canvas document as React Flow nodes, and React Flow's edits back
// into the document. Pure, so it is tested without a DOM.
//
// Frames keep absolute positions; a group or artboard is a frame its members
// point at with `groupId`, not a React Flow parent. Those are listed first so
// their members draw above them, and moving one moves its members here.
// Arrows and lines are drawn where their ends are now (see connectors.ts)
// and take the pointer only on the line itself.

import type { Node, NodeChange } from "@xyflow/react";
import {
  connectorGeometry,
  syncConnectors,
  translateConnector,
  type DesignPoint,
} from "../shared/design-canvas/connectors";
import { commentsWithoutFrames } from "../shared/design-canvas/comments";
import { clampCoord, clampSize, copyFrames } from "../shared/design-canvas/placement";
import {
  APP_DEFAULT_VIEWPORT,
  appEdgeResize,
  appFrameBox,
  appResizeScale,
  type AppResizeMode,
  type AppResizeSide,
} from "../shared/design-canvas/app-frame";
import {
  DESIGN_CANVAS_LIMITS,
  isDesignContainer,
  isDesignLine,
  type DesignCanvas,
  type DesignFrame,
} from "../shared/design-canvas/schema";

export type DesignNode = Node<
  { frame: DesignFrame; /** A connector's two ends, in canvas units. */ ends?: [DesignPoint, DesignPoint] },
  DesignFrame["kind"]
>;

/** How far a duplicate sits from its original. */
export const DESIGN_DUPLICATE_OFFSET = 32;

// Placement is shared with main, where Aiden's canvas tools place frames.
export {
  DESIGN_FRAME_GAP,
  placeFrame,
  type PlaceFrameInput,
} from "../shared/design-canvas/placement";

/** One page as React Flow nodes; frames on other pages are not drawn. */
export function nodesFromCanvas(doc: DesignCanvas, pageId: string, selection: ReadonlySet<string>): DesignNode[] {
  const onPage = doc.frames.filter((frame) => frame.pageId === pageId);
  const containers = onPage.filter((frame) => isDesignContainer(frame.kind));
  const others = onPage.filter((frame) => !isDesignContainer(frame.kind));
  const byId = new Map(doc.frames.map((frame) => [frame.id, frame]));
  return [...containers, ...others].map((frame): DesignNode => {
    const geometry = frame.kind === "connector" ? connectorGeometry(byId, frame) : undefined;
    const box = geometry?.box ?? frame;
    // An item in a hidden group or artboard is hidden with it.
    const hidden = frame.hidden === true || (frame.groupId !== undefined && byId.get(frame.groupId)?.hidden === true);
    return {
      id: frame.id,
      type: frame.kind,
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      selected: selection.has(frame.id),
      ...(hidden ? { hidden: true } : {}),
      // A locked item can be selected (to unlock it) but not moved, resized or removed.
      ...(frame.locked ? { draggable: false, deletable: false, className: "design-locked" } : {}),
      data: geometry ? { frame, ends: geometry.ends } : { frame },
      // A line takes the pointer only where it is drawn, so what is under its box stays reachable.
      ...(isDesignLine(frame.kind) ? { style: { pointerEvents: "none" as const } } : {}),
    };
  });
}

/**
 * What Present and Open full window draw for one frame: the frame, what is
 * in it (a group's or artboard's members, at any depth), and the arrows whose
 * attached ends are all on those. Neighbours, even overlapping ones, are left out.
 */
export function presentedFrameIds(doc: DesignCanvas, id: string): Set<string> {
  const shown = new Set<string>();
  if (!doc.frames.some((frame) => frame.id === id)) return shown;
  shown.add(id);
  // Members can nest, so go round until a pass adds nothing.
  for (let grew = true; grew; ) {
    grew = false;
    for (const frame of doc.frames) {
      if (!shown.has(frame.id) && frame.groupId !== undefined && shown.has(frame.groupId)) {
        shown.add(frame.id);
        grew = true;
      }
    }
  }
  for (const frame of doc.frames) {
    if (frame.kind !== "connector" || shown.has(frame.id) || !frame.ends) continue;
    const attached = frame.ends.flatMap((end) => (end.frameId ? [end.frameId] : []));
    if (attached.length > 0 && attached.every((frameId) => shown.has(frameId))) shown.add(frame.id);
  }
  return shown;
}

/**
 * Applies position, resize and remove changes. Selection and React Flow's own
 * measurements are not document edits; when nothing in `changes` edits the
 * document, the same object comes back so callers can skip the save.
 *
 * `resizeModes` names the control each live app frame is being resized by
 * (3c, S89). A corner (or no entry) keeps today's rule: the aspect stays and
 * the scale changes. An edge changes the viewport and keeps the scale: the
 * batch's position and size go through `appEdgeResize` once, from the frame as
 * it was before the batch, and its box overrides any position change.
 */
export function applyNodeChanges(
  doc: DesignCanvas,
  changes: NodeChange<DesignNode>[],
  resizeModes?: ReadonlyMap<string, AppResizeMode>,
): DesignCanvas {
  const boxes = new Map<string, Pick<DesignFrame, "x" | "y" | "w" | "h">>();
  /** A live app frame's new scale after a resize: its aspect stays (D15). */
  const scales = new Map<string, number>();
  /** A live app frame's new viewport after an edge drag (S89). */
  const viewports = new Map<string, { width: number; height: number }>();
  /** What an edge drag of a live app frame asked for in this batch: xyflow's position and size. */
  const edgeDrags = new Map<string, { side: AppResizeSide; x?: number; y?: number; w?: number; h?: number }>();
  const edgeOf = (id: string): AppResizeSide | undefined => {
    const mode = resizeModes?.get(id);
    return mode !== undefined && mode !== "corner" && original.get(id)?.kind === "app" ? mode : undefined;
  };
  const moved = new Set<string>();
  const removed = new Set<string>();
  const original = new Map(doc.frames.map((frame) => [frame.id, frame]));
  const boxOf = (id: string) => {
    const existing = boxes.get(id);
    if (existing) return existing;
    const frame = original.get(id)!;
    const box = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    boxes.set(id, box);
    return box;
  };

  for (const change of changes) {
    if (change.type === "add" || change.type === "replace" || change.type === "select") continue;
    if (!original.has(change.id) || original.get(change.id)!.locked) continue;
    if (change.type === "remove") {
      removed.add(change.id);
    } else if (change.type === "position") {
      if (!change.position) continue;
      const side = edgeOf(change.id);
      if (side) {
        edgeDrags.set(change.id, { ...edgeDrags.get(change.id), side, x: change.position.x, y: change.position.y });
        continue;
      }
      const box = boxOf(change.id);
      box.x = clampCoord(change.position.x);
      box.y = clampCoord(change.position.y);
      moved.add(change.id);
    } else if (change.type === "dimensions") {
      // Measurements arrive without `resizing` or `setAttributes`; only a resize edits the frame.
      if (!change.dimensions || (change.resizing === undefined && !change.setAttributes)) continue;
      // A connector's box is where its ends are; it is not resized.
      if (original.get(change.id)!.kind === "connector") continue;
      const box = boxOf(change.id);
      const frame = original.get(change.id)!;
      const kind = frame.kind;
      const side = edgeOf(change.id);
      if (side) {
        edgeDrags.set(change.id, { ...edgeDrags.get(change.id), side, w: change.dimensions.width, h: change.dimensions.height });
        continue;
      }
      if (kind === "app") {
        // The width decides the scale unless only the height moved; the box follows the viewport.
        const width = change.dimensions.width !== box.w || change.dimensions.height === box.h ? change.dimensions.width : undefined;
        const scale = appResizeScale(frame.viewport, width, change.dimensions.height, DESIGN_CANVAS_LIMITS.maxSize);
        const shown = appFrameBox(frame.viewport ?? APP_DEFAULT_VIEWPORT, scale);
        scales.set(change.id, scale);
        box.w = shown.w;
        box.h = shown.h;
        continue;
      }
      box.w = clampSize(change.dimensions.width, kind);
      box.h = clampSize(change.dimensions.height, kind);
    }
  }

  // One edge rule per frame per batch, from the frame before it (S89).
  for (const [id, { side, ...drag }] of edgeDrags) {
    const frame = original.get(id)!;
    const next = appEdgeResize(frame, side, drag, DESIGN_CANVAS_LIMITS.maxSize);
    boxes.set(id, { x: clampCoord(next.x), y: clampCoord(next.y), w: next.w, h: next.h });
    viewports.set(id, next.viewport);
  }

  // A moved group or artboard carries its members, unless a member moved on its own in the same change.
  for (const id of moved) {
    const group = original.get(id)!;
    if (!isDesignContainer(group.kind)) continue;
    const box = boxes.get(id)!;
    const dx = box.x - group.x;
    const dy = box.y - group.y;
    if (dx === 0 && dy === 0) continue;
    for (const member of doc.frames) {
      if (member.groupId !== id || moved.has(member.id)) continue;
      const memberBox = boxOf(member.id);
      memberBox.x = clampCoord(memberBox.x + dx);
      memberBox.y = clampCoord(memberBox.y + dy);
    }
  }

  let changed = removed.size > 0;
  const frames: DesignFrame[] = [];
  for (const frame of doc.frames) {
    if (removed.has(frame.id)) continue;
    let next = frame;
    const box = boxes.get(frame.id);
    if (box && frame.kind === "connector") {
      // A dragged connector moves its free ends by as much as its box moved.
      const drawn = connectorGeometry(original, frame).box;
      next = translateConnector(frame, box.x - drawn.x, box.y - drawn.y);
    } else if (box) {
      const viewport = viewports.get(frame.id);
      const own = frame.viewport ?? APP_DEFAULT_VIEWPORT;
      // At small scales a one-pixel viewport change can round to the same box, and still counts.
      const reflowed = viewport !== undefined && (viewport.width !== own.width || viewport.height !== own.height);
      if (reflowed || box.x !== frame.x || box.y !== frame.y || box.w !== frame.w || box.h !== frame.h) {
        next = { ...frame, ...box };
        const scale = scales.get(frame.id);
        if (scale !== undefined) next.scale = scale;
        if (viewport !== undefined) next.viewport = viewport;
      }
    }
    if (next.groupId && removed.has(next.groupId)) {
      const { groupId: _groupId, ...rest } = next;
      next = rest;
    }
    if (next !== frame) changed = true;
    frames.push(next);
  }
  if (!changed) return doc;
  const comments = removed.size > 0 ? commentsWithoutFrames(doc.comments, removed) : doc.comments;
  // Arrows follow the frames that moved, and let go of the ones removed where they last were.
  return syncConnectors({ ...doc, frames, comments });
}

/**
 * One undo step per drag or resize. The first change of a gesture that alters
 * the canvas records the step (a first change that rounds back to the same
 * document records nothing, so the next one must); later changes join it, and
 * the gesture's last change ends it. `gesture` is the canvas's own flag.
 */
export function gestureEdit(
  gesture: { current: boolean },
  edits: readonly NodeChange<DesignNode>[],
  mutate: (doc: DesignCanvas) => DesignCanvas,
): { record: boolean; mutate: (doc: DesignCanvas) => DesignCanvas } {
  const flags = edits.map((entry) =>
    entry.type === "position" ? entry.dragging : entry.type === "dimensions" ? entry.resizing : undefined,
  );
  if (flags.includes(true)) {
    if (gesture.current) return { record: false, mutate };
    // The gesture starts with the first change that alters the canvas, the
    // first time it runs (a save conflict replays the same change later).
    let first = true;
    return {
      record: true,
      mutate: (doc) => {
        const next = mutate(doc);
        if (first && next !== doc) gesture.current = true;
        first = false;
        return next;
      },
    };
  }
  if (flags.includes(false)) {
    const record = !gesture.current;
    gesture.current = false;
    return { record, mutate };
  }
  return { record: true, mutate };
}

/**
 * Copies frames 32 px down and right. A copied group brings copies of its
 * members and keeps its lock; a member copied alone joins its group, unless
 * that group is locked, when the copy stands outside any group. Other copies
 * are unlocked. All or nothing: a copy that would pass the frame limit
 * returns `doc` unchanged.
 */
export function duplicateFrames(
  doc: DesignCanvas,
  ids: string[],
  newId: () => string,
): DesignCanvas {
  const copied = copyFrames(doc, ids, newId, {
    dx: DESIGN_DUPLICATE_OFFSET,
    dy: DESIGN_DUPLICATE_OFFSET,
    createdBy: "person",
    keepGroupLock: true,
  });
  return copied ? copied.doc : doc;
}

export type CanvasFocusResolution =
  | { action: "wait" }
  | { action: "drop" }
  | { action: "fit"; ids: string[] };

/**
 * Decides whether a pending `canvas_focus` request should wait for frames to
 * arrive and be measured by React Flow, drop if none arrived before the wait
 * budget, or fit the target frames (empty `ids` fits the whole page).
 */
export function resolveCanvasFocus(input: {
  requestedIds: readonly string[];
  nodeIds: readonly string[];
  hiddenIds?: readonly string[];
  isMeasured: (id: string) => boolean;
  waitedMs: number;
  maxWaitMs: number;
}): CanvasFocusResolution {
  const hidden = new Set(input.hiddenIds);
  const visibleNodeIds = input.nodeIds.filter((id) => !hidden.has(id));
  const requestedVisible = input.requestedIds.filter((id) => !hidden.has(id));
  if (input.requestedIds.length > 0 && requestedVisible.length === 0) return { action: "drop" };
  if (input.requestedIds.length === 0 && input.nodeIds.length > 0 && visibleNodeIds.length === 0) {
    return { action: "drop" };
  }
  const present = requestedVisible.filter((id) => visibleNodeIds.includes(id));
  const measuredIds = present.length > 0 ? present : visibleNodeIds;
  const measured = measuredIds.length > 0 && measuredIds.every((id) => input.isMeasured(id));
  const arriving = present.length < requestedVisible.length || (visibleNodeIds.length > 0 && !measured);
  if (arriving && input.waitedMs < input.maxWaitMs) return { action: "wait" };
  if (input.requestedIds.length > 0 && present.length === 0) return { action: "drop" };
  return { action: "fit", ids: present };
}
