// The design canvas document as React Flow nodes, and React Flow's edits back
// into the document. Pure, so it is tested without a DOM.
//
// Frames keep absolute positions; a group is a frame its members point at
// with `groupId`, not a React Flow parent. Groups are listed first so their
// members draw above them, and moving a group moves its members here.

import type { Node, NodeChange } from "@xyflow/react";
import { clampCoord, clampSize } from "../shared/design-canvas/placement";
import {
  DESIGN_CANVAS_LIMITS,
  type DesignCanvas,
  type DesignFrame,
} from "../shared/design-canvas/schema";

export type DesignNode = Node<{ frame: DesignFrame }, DesignFrame["kind"]>;

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
  const groups = onPage.filter((frame) => frame.kind === "group");
  const others = onPage.filter((frame) => frame.kind !== "group");
  return [...groups, ...others].map((frame) => ({
    id: frame.id,
    type: frame.kind,
    position: { x: frame.x, y: frame.y },
    width: frame.w,
    height: frame.h,
    selected: selection.has(frame.id),
    data: { frame },
  }));
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
    if (!original.has(change.id)) continue;
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
      const box = boxOf(change.id);
      box.w = clampSize(change.dimensions.width);
      box.h = clampSize(change.dimensions.height);
    }
  }

  // A moved group carries its members, unless a member moved on its own in the same change.
  for (const id of moved) {
    const group = original.get(id)!;
    if (group.kind !== "group") continue;
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
    if (box && (box.x !== frame.x || box.y !== frame.y || box.w !== frame.w || box.h !== frame.h)) {
      next = { ...frame, ...box };
    }
    if (next.groupId && removed.has(next.groupId)) {
      const { groupId: _groupId, ...rest } = next;
      next = rest;
    }
    if (next !== frame) changed = true;
    frames.push(next);
  }
  return changed ? { ...doc, frames } : doc;
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
    doc.frames.filter((frame) => chosen.has(frame.id) && frame.kind === "group").map((frame) => frame.id),
  );
  const sources = doc.frames.filter(
    (frame) => chosen.has(frame.id) || (frame.groupId !== undefined && groupIds.has(frame.groupId)),
  );
  if (sources.length === 0) return doc;
  if (doc.frames.length + sources.length > DESIGN_CANVAS_LIMITS.frames) return doc;
  // Groups first, so members can point at their group's copy.
  const ordered = [...sources.filter((frame) => frame.kind === "group"), ...sources.filter((frame) => frame.kind !== "group")];
  const copies = new Map<string, string>();
  const added: DesignFrame[] = [];
  for (const frame of ordered) {
    const id = newId();
    copies.set(frame.id, id);
    const groupId = frame.groupId ? (copies.get(frame.groupId) ?? frame.groupId) : undefined;
    added.push({
      ...frame,
      id,
      x: clampCoord(frame.x + DESIGN_DUPLICATE_OFFSET),
      y: clampCoord(frame.y + DESIGN_DUPLICATE_OFFSET),
      ...(groupId ? { groupId } : {}),
      createdBy: "person",
    });
  }
  return { ...doc, frames: [...doc.frames, ...added] };
}
