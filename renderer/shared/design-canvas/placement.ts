// Where a new frame goes on the design canvas. Pure, and shared by the
// renderer's Add menu and main's canvas tools, so a frame Aiden places lands
// where the same frame added by hand would.

import { syncConnectors } from "./connectors.js";
import {
  DESIGN_CANVAS_LIMITS,
  designMinSize,
  isDesignContainer,
  type DesignCanvas,
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
  // A group (not an artboard, which keeps the size the person drew) grows to
  // hold a member placed past its right or bottom edge.
  const frames = [...doc.frames, placed].map((entry) =>
    group && entry.id === group.id && group.kind === "group" ? growGroupToHold(entry, placed) : entry,
  );
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
