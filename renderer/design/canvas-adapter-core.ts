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
import { clampCoord, clampSize } from "../shared/design-canvas/placement";
import {
  DESIGN_CANVAS_LIMITS,
  isDesignContainer,
  isDesignLine,
  type DesignCanvas,
  type DesignConnectorEnd,
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

/** The page on screen as React Flow nodes; frames on other pages are not drawn. */
export function nodesFromCanvas(doc: DesignCanvas, selection: ReadonlySet<string>): DesignNode[] {
  const onPage = doc.frames.filter((frame) => frame.pageId === doc.activePageId);
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
 */
export function applyNodeChanges(
  doc: DesignCanvas,
  changes: NodeChange<DesignNode>[],
): DesignCanvas {
  const boxes = new Map<string, Pick<DesignFrame, "x" | "y" | "w" | "h">>();
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
      const kind = original.get(change.id)!.kind;
      box.w = clampSize(change.dimensions.width, kind);
      box.h = clampSize(change.dimensions.height, kind);
    }
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
    } else if (box && (box.x !== frame.x || box.y !== frame.y || box.w !== frame.w || box.h !== frame.h)) {
      next = { ...frame, ...box };
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
 * Copies frames 32 px down and right. A copied group brings copies of its
 * members; a member copied alone stays in its group. All or nothing: a copy
 * that would pass the frame limit returns `doc` unchanged.
 */
export function duplicateFrames(
  doc: DesignCanvas,
  ids: string[],
  newId: () => string,
): DesignCanvas {
  const chosen = new Set(ids);
  const groupIds = new Set(
    doc.frames.filter((frame) => chosen.has(frame.id) && isDesignContainer(frame.kind)).map((frame) => frame.id),
  );
  const sources = doc.frames.filter(
    (frame) => chosen.has(frame.id) || (frame.groupId !== undefined && groupIds.has(frame.groupId)),
  );
  if (sources.length === 0) return doc;
  if (doc.frames.length + sources.length > DESIGN_CANVAS_LIMITS.frames) return doc;
  const pageId = sources[0]!.pageId;
  const onPage = doc.frames.filter((frame) => frame.pageId === pageId).length;
  if (onPage + sources.length > DESIGN_CANVAS_LIMITS.framesPerPage) return doc;
  // Groups first, so members can point at their group's copy.
  const ordered = [
    ...sources.filter((frame) => isDesignContainer(frame.kind)),
    ...sources.filter((frame) => !isDesignContainer(frame.kind)),
  ];
  const copies = new Map<string, string>();
  for (const frame of ordered) copies.set(frame.id, newId());
  const added: DesignFrame[] = [];
  for (const frame of ordered) {
    const groupId = frame.groupId ? (copies.get(frame.groupId) ?? frame.groupId) : undefined;
    // A copied arrow joins the copies of its frames; an end on a frame left behind becomes a free end.
    const ends = frame.ends?.map((end): DesignConnectorEnd => {
      const target = end.frameId !== undefined ? copies.get(end.frameId) : undefined;
      if (target) return { ...end, frameId: target };
      return { x: clampCoord(end.x + DESIGN_DUPLICATE_OFFSET), y: clampCoord(end.y + DESIGN_DUPLICATE_OFFSET) };
    }) as DesignFrame["ends"];
    const { locked: _locked, ...unlocked } = frame;
    added.push({
      ...unlocked,
      id: copies.get(frame.id)!,
      x: clampCoord(frame.x + DESIGN_DUPLICATE_OFFSET),
      y: clampCoord(frame.y + DESIGN_DUPLICATE_OFFSET),
      ...(groupId ? { groupId } : {}),
      ...(ends ? { ends } : {}),
      createdBy: "person",
    });
  }
  return syncConnectors({ ...doc, frames: [...doc.frames, ...added] });
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
