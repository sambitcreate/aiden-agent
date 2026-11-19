// Where a new frame goes on the design canvas. Pure, and shared by the
// renderer's Add menu and main's canvas tools, so a frame Aiden places lands
// where the same frame added by hand would.

import { syncConnectors } from "./connectors.js";
import {
  DESIGN_CANVAS_LIMITS,
  designMinSize,
  isDesignContainer,
  type DesignCanvas,
  type DesignConnectorEnd,
  type DesignFrame,
  type DesignFrameKind,
} from "./schema.js";

/** Space between a group's frames when one is placed after the last. */
export const DESIGN_FRAME_GAP = 64;
/** A group's first frame sits this far in from the group's top-left corner. */
const GROUP_INSET = { x: 32, y: 48 } as const;

/** A width or height a frame of `kind` can have (a page frame's when no kind is given). */
export const clampSize = (value: number, kind?: DesignFrameKind) =>
  Math.min(
    DESIGN_CANVAS_LIMITS.maxSize,
    Math.max(kind ? designMinSize(kind) : DESIGN_CANVAS_LIMITS.minSize, Math.round(value)),
  );
export const clampCoord = (value: number) =>
  Math.min(DESIGN_CANVAS_LIMITS.maxCoord, Math.max(-DESIGN_CANVAS_LIMITS.maxCoord, Math.round(value)));

/** A frame to place; it goes on `pageId`, or on the page on screen. */
export type PlaceFrameInput = Omit<DesignFrame, "id" | "x" | "y" | "pageId"> &
  Partial<Pick<DesignFrame, "x" | "y" | "pageId">>;

/**
 * Adds a frame. Without a position it goes 64 px right of the last frame in
 * its group (top-aligned), inside an empty group's corner, 64 px right of the
 * last ungrouped frame in the visible part of the canvas (`view`, in canvas
 * coordinates), or centred in that view when none is visible. Only frames on
 * the same page count, and a group on another page is no group.
 */
export function placeFrame(
  doc: DesignCanvas,
  frame: PlaceFrameInput,
  view: { x: number; y: number; w: number; h: number },
  newId: () => string,
): { doc: DesignCanvas; id: string } | { error: "limit" } {
  const w = clampSize(frame.w, frame.kind);
  const h = clampSize(frame.h, frame.kind);
  const pageId =
    frame.pageId !== undefined && doc.pages.some((page) => page.id === frame.pageId) ? frame.pageId : doc.activePageId;
  const onPage = doc.frames.filter((entry) => entry.pageId === pageId);
  if (doc.frames.length >= DESIGN_CANVAS_LIMITS.frames || onPage.length >= DESIGN_CANVAS_LIMITS.framesPerPage) {
    return { error: "limit" };
  }
  const group =
    frame.groupId && !isDesignContainer(frame.kind)
      ? onPage.find((entry) => entry.id === frame.groupId && isDesignContainer(entry.kind))
      : undefined;
  let position: { x: number; y: number };
  if (frame.x !== undefined && frame.y !== undefined) {
    position = { x: frame.x, y: frame.y };
  } else if (group) {
    const members = onPage.filter((entry) => entry.groupId === group.id);
    const last = members[members.length - 1];
    position = last
      ? { x: last.x + last.w + DESIGN_FRAME_GAP, y: last.y }
      : { x: group.x + GROUP_INSET.x, y: group.y + GROUP_INSET.y };
    // An artboard keeps the width the person drew, so what would run past its
    // right edge starts a new row inside it, below everything already there.
    if (last && group.kind === "frame" && position.x + w > group.x + group.w - GROUP_PADDING.right) {
      position = {
        x: group.x + GROUP_INSET.x,
        y: Math.max(...members.map((entry) => entry.y + entry.h)) + DESIGN_FRAME_GAP,
      };
    }
  } else {
    const ungrouped = onPage.filter((entry) => entry.groupId === undefined);
    const overlaps = (entry: DesignFrame, box: { x: number; y: number; w: number; h: number }) =>
      entry.x < box.x + box.w && box.x < entry.x + entry.w && entry.y < box.y + box.h && box.y < entry.y + entry.h;
    const inView = ungrouped.filter((entry) => overlaps(entry, view));
    const last = inView[inView.length - 1];
    position = last
      ? { x: last.x + last.w + DESIGN_FRAME_GAP, y: last.y }
      : { x: view.x + (view.w - w) / 2, y: view.y + (view.h - h) / 2 };
    // A frame already there (an earlier one that ran past the view) pushes the
    // new one further right, so frames added in a row never stack.
    for (let blocker = ungrouped.find((entry) => overlaps(entry, { ...position, w, h })); blocker; ) {
      position = { x: blocker.x + blocker.w + DESIGN_FRAME_GAP, y: position.y };
      blocker = ungrouped.find((entry) => overlaps(entry, { ...position, w, h }));
    }
  }
  const id = newId();
  const { groupId: _groupId, pageId: _pageId, ...rest } = frame;
  const placed: DesignFrame = {
    ...rest,
    pageId,
    ...(group ? { groupId: group.id } : {}),
    id,
    x: clampCoord(position.x),
    y: clampCoord(position.y),
    w,
    h,
  };
  // A group grows to hold a member placed past its right or bottom edge; an
  // artboard keeps the width the person drew and grows only down, to hold a
  // new row. A locked one keeps its box.
  const frames = [...doc.frames, placed].map((entry) => {
    if (!group || entry.id !== group.id || group.locked) return entry;
    if (group.kind === "group") return growGroupToHold(entry, placed);
    const grown = growGroupToHold(entry, placed);
    return grown.h === entry.h ? entry : { ...entry, h: grown.h };
  });
  // A new arrow takes its place on the frames it joins.
  return { id, doc: syncConnectors({ ...doc, frames }) };
}

/** Space a group keeps around its members when it grows or is fitted to them. */
export const GROUP_PADDING = { left: 32, top: 48, right: 32, bottom: 32 } as const;

/** A group grown right and down, if needed, to hold `member` with `GROUP_PADDING` to spare. */
export function growGroupToHold(group: DesignFrame, member: DesignFrame): DesignFrame {
  const right = member.x + member.w + GROUP_PADDING.right;
  const bottom = member.y + member.h + GROUP_PADDING.bottom;
  const w = right > group.x + group.w ? clampSize(right - group.x, group.kind) : group.w;
  const h = bottom > group.y + group.h ? clampSize(bottom - group.y, group.kind) : group.h;
  return w === group.w && h === group.h ? group : { ...group, w, h };
}

/**
 * Fits each unlocked group named in `ids` (not an artboard, which keeps the
 * size the person drew) to its members again, after one was added, moved,
 * resized or removed. Missing ids, artboards and empty groups are left alone.
 */
export function refitGroups(doc: DesignCanvas, ids: Iterable<string | undefined>): DesignCanvas {
  let next = doc;
  for (const id of new Set(ids)) {
    if (id === undefined) continue;
    const group = next.frames.find((entry) => entry.id === id);
    if (group?.kind === "group" && !group.locked) next = fitGroupToMembers(next, id);
  }
  return next;
}

/**
 * Fits a group or artboard snugly around its members, `GROUP_PADDING` in from
 * each edge. The members stay where they are; the container moves and
 * resizes. A container with no members is left as it is.
 */
export function fitGroupToMembers(doc: DesignCanvas, groupId: string): DesignCanvas {
  const group = doc.frames.find((entry) => entry.id === groupId && isDesignContainer(entry.kind));
  if (!group) return doc;
  const members = doc.frames.filter((entry) => entry.groupId === groupId && entry.pageId === group.pageId);
  if (members.length === 0) return doc;
  const left = Math.min(...members.map((entry) => entry.x)) - GROUP_PADDING.left;
  const top = Math.min(...members.map((entry) => entry.y)) - GROUP_PADDING.top;
  const right = Math.max(...members.map((entry) => entry.x + entry.w)) + GROUP_PADDING.right;
  const bottom = Math.max(...members.map((entry) => entry.y + entry.h)) + GROUP_PADDING.bottom;
  const next = {
    x: clampCoord(left),
    y: clampCoord(top),
    w: clampSize(right - left, group.kind),
    h: clampSize(bottom - top, group.kind),
  };
  if (next.x === group.x && next.y === group.y && next.w === group.w && next.h === group.h) return doc;
  return syncConnectors({
    ...doc,
    frames: doc.frames.map((entry) => (entry.id === groupId ? { ...entry, ...next } : entry)),
  });
}

/** Which side of a frame another goes on. */
export type DesignBeside = "right" | "left" | "below" | "above";

type Box = { x: number; y: number; w: number; h: number };
const overlapsBox = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where a box of `size` goes beside `anchor`: 64 px off the chosen side,
 * top-aligned (left-aligned above or below). A frame of `others` already
 * there pushes it further the same way, so it never lands on one.
 */
export function besideBox(
  anchor: Box,
  size: { w: number; h: number },
  side: DesignBeside,
  others: readonly Box[],
): { x: number; y: number } {
  const step = (from: Box) =>
    side === "right"
      ? { x: from.x + from.w + DESIGN_FRAME_GAP, y: anchor.y }
      : side === "left"
        ? { x: from.x - DESIGN_FRAME_GAP - size.w, y: anchor.y }
        : side === "below"
          ? { x: anchor.x, y: from.y + from.h + DESIGN_FRAME_GAP }
          : { x: anchor.x, y: from.y - DESIGN_FRAME_GAP - size.h };
  let at = step(anchor);
  // Each step passes a blocker, so this ends within one step per frame.
  for (let tries = 0; tries <= others.length; tries += 1) {
    const blocker = others.find((entry) => overlapsBox(entry, { ...at, ...size }));
    if (!blocker) break;
    at = step(blocker);
  }
  return { x: clampCoord(at.x), y: clampCoord(at.y) };
}

/**
 * Copies frames moved by (dx, dy). A copied group or artboard brings copies
 * of its members; a member copied alone joins its group, unless that group is
 * locked, when the copy stands outside any group. A copied arrow joins the
 * copies of its frames, and an end on a frame left behind becomes a free end.
 * Copies are unlocked, except a copied group when `keepGroupLock`, which keeps
 * its lock along with its members. Returns null when the copies would pass the
 * frame limits. `copies` maps each source id to its copy's.
 */
export function copyFrames(
  doc: DesignCanvas,
  ids: readonly string[],
  newId: () => string,
  options: { dx: number; dy: number; createdBy: DesignFrame["createdBy"]; keepGroupLock: boolean },
): { doc: DesignCanvas; copies: Map<string, string> } | null {
  const chosen = new Set(ids);
  const groupIds = new Set(
    doc.frames.filter((frame) => chosen.has(frame.id) && isDesignContainer(frame.kind)).map((frame) => frame.id),
  );
  const sources = doc.frames.filter(
    (frame) => chosen.has(frame.id) || (frame.groupId !== undefined && groupIds.has(frame.groupId)),
  );
  if (sources.length === 0) return { doc, copies: new Map() };
  if (doc.frames.length + sources.length > DESIGN_CANVAS_LIMITS.frames) return null;
  const pageId = sources[0]!.pageId;
  const onPage = doc.frames.filter((frame) => frame.pageId === pageId).length;
  if (onPage + sources.length > DESIGN_CANVAS_LIMITS.framesPerPage) return null;
  const { dx, dy } = options;
  // Groups first, so members can point at their group's copy.
  const ordered = [
    ...sources.filter((frame) => isDesignContainer(frame.kind)),
    ...sources.filter((frame) => !isDesignContainer(frame.kind)),
  ];
  const copies = new Map<string, string>();
  for (const frame of ordered) copies.set(frame.id, newId());
  const lockedGroups = new Set(doc.frames.filter((frame) => frame.locked && isDesignContainer(frame.kind)).map((frame) => frame.id));
  const added: DesignFrame[] = [];
  for (const frame of ordered) {
    // A copy joins its group's copy, or the group itself, but never a locked group it was not copied with.
    const groupId = frame.groupId && (copies.get(frame.groupId) ?? (lockedGroups.has(frame.groupId) ? undefined : frame.groupId));
    const ends = frame.ends?.map((end): DesignConnectorEnd => {
      const target = end.frameId !== undefined ? copies.get(end.frameId) : undefined;
      if (target) return { ...end, frameId: target };
      return { x: clampCoord(end.x + dx), y: clampCoord(end.y + dy) };
    }) as DesignFrame["ends"];
    const { locked, groupId: _groupId, ...unlocked } = frame;
    added.push({
      ...unlocked,
      ...(locked && options.keepGroupLock && isDesignContainer(frame.kind) ? { locked } : {}),
      id: copies.get(frame.id)!,
      x: clampCoord(frame.x + dx),
      y: clampCoord(frame.y + dy),
      ...(groupId ? { groupId } : {}),
      ...(ends ? { ends } : {}),
      createdBy: options.createdBy,
    });
  }
  return { doc: syncConnectors({ ...doc, frames: [...doc.frames, ...added] }), copies };
}
