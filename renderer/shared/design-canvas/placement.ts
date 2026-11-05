// Where a new frame goes on the design canvas. Pure, and shared by the
// renderer's Add menu and main's canvas tools, so a frame Aiden places lands
// where the same frame added by hand would.

import {
  DESIGN_CANVAS_LIMITS,
  type DesignCanvas,
  type DesignFrame,
} from "./schema.js";

/** Space between a group's frames when one is placed after the last. */
export const DESIGN_FRAME_GAP = 64;
/** A group's first frame sits this far in from the group's top-left corner. */
const GROUP_INSET = { x: 32, y: 48 } as const;

export const clampSize = (value: number) =>
  Math.min(DESIGN_CANVAS_LIMITS.maxSize, Math.max(DESIGN_CANVAS_LIMITS.minSize, Math.round(value)));
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
  if (doc.frames.length >= DESIGN_CANVAS_LIMITS.frames) return { error: "limit" };
  const w = clampSize(frame.w);
  const h = clampSize(frame.h);
  const pageId =
    frame.pageId !== undefined && doc.pages.some((page) => page.id === frame.pageId) ? frame.pageId : doc.activePageId;
  const onPage = doc.frames.filter((entry) => entry.pageId === pageId);
  const group = frame.groupId
    ? onPage.find((entry) => entry.id === frame.groupId && entry.kind === "group")
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
  return { id, doc: { ...doc, frames: [...doc.frames, placed] } };
}

