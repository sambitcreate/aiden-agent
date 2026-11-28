// Variant sets of live app frames (design mode v2 Phases 3b and 3c, S85 and
// S93): a variant goes right of its set, top-aligned with the original, in the
// original's group or in a new group made around both. Shared by Aiden's
// canvas_place_frame and the person's Add view at width and Duplicate page as
// variant, so both place a variant the same way.

import { appFrameBox } from "./app-frame.js";
import { DESIGN_FRAME_GAP, fitGroupToMembers, placeFrame, refitGroups, type PlaceFrameInput } from "./placement.js";
import { DESIGN_CANVAS_LIMITS, isDesignContainer, type DesignCanvas, type DesignFrame } from "./schema.js";

/** A group made around an original and its first variant starts at the canvas's default group box, then fits them. */
const VARIANT_GROUP_BOX = { w: 640, h: 400 } as const;

export type AppVariantInput = {
  /** The new frame's id. */
  id: string;
  /** The id a new group around the original and the variant gets, when the original has none. */
  groupId: string;
  title: string;
  route: string;
  viewport: { width: number; height: number };
  scale: number;
  label?: string;
  createdBy: "aiden" | "person";
  /** Look fields to apply (a layout guide). */
  style?: Partial<DesignFrame>;
};

export type AppVariantRefusal = "locked" | "locked-group" | "page-full" | "canvas-full";

/** The frame a variant set hangs off: the app frame `frame.variantOf` names on its page, or `frame` itself. */
export function variantRootOf(doc: DesignCanvas, frame: DesignFrame): DesignFrame {
  if (frame.variantOf === undefined) return frame;
  const root = doc.frames.find((entry) => entry.id === frame.variantOf && entry.kind === "app" && entry.pageId === frame.pageId);
  return root ?? frame;
}

/**
 * Places a variant of `original` (the set's root, as the caller decides):
 * right of the set, at the original's top, in its group, or in a new group
 * around both. A locked original or group, or a page or canvas without room
 * for the frame (and the new group), is refused and the document is unchanged.
 */
export function placeAppVariant(
  doc: DesignCanvas,
  original: DesignFrame,
  input: AppVariantInput,
): { doc: DesignCanvas; frameId: string } | { error: AppVariantRefusal } {
  if (original.locked) return { error: "locked" };
  const pageId = original.pageId;
  const group = original.groupId
    ? doc.frames.find((entry) => entry.id === original.groupId && isDesignContainer(entry.kind) && entry.pageId === pageId)
    : undefined;
  if (group?.locked) return { error: "locked-group" };
  // The new group counts too, or the store would drop it on save.
  const adding = group ? 1 : 2;
  if (doc.frames.filter((entry) => entry.pageId === pageId).length + adding > DESIGN_CANVAS_LIMITS.framesPerPage) return { error: "page-full" };
  if (doc.frames.length + adding > DESIGN_CANVAS_LIMITS.frames) return { error: "canvas-full" };

  const set = doc.frames.filter((entry) => entry.pageId === pageId && (entry.id === original.id || entry.variantOf === original.id));
  const at = { x: Math.max(...set.map((entry) => entry.x + entry.w)) + DESIGN_FRAME_GAP, y: original.y };
  const frame: PlaceFrameInput = {
    kind: "app",
    title: input.title,
    pageId,
    ...appFrameBox(input.viewport, input.scale),
    createdBy: input.createdBy,
    appRoot: original.appRoot,
    route: input.route,
    viewport: { width: input.viewport.width, height: input.viewport.height },
    scale: input.scale,
    ...(input.label ? { label: input.label } : {}),
    variantOf: original.id,
    ...at,
    ...(group ? { groupId: group.id } : {}),
    ...input.style,
  };
  // The position is given, so the view placeFrame would centre in is unused.
  const placed = placeFrame(doc, frame, { x: at.x, y: at.y, w: 0, h: 0 }, () => input.id);
  if ("error" in placed) return { error: "canvas-full" };
  let next = refitGroups(placed.doc, [group?.id]);
  if (!group) {
    const members = new Set([original.id, input.id]);
    next = fitGroupToMembers(
      {
        ...next,
        frames: [
          ...next.frames.map((entry) => (members.has(entry.id) ? { ...entry, groupId: input.groupId } : entry)),
          {
            id: input.groupId,
            kind: "group",
            title: (original.route ?? "/").slice(0, DESIGN_CANVAS_LIMITS.titleChars),
            pageId,
            x: original.x,
            y: original.y,
            w: VARIANT_GROUP_BOX.w,
            h: VARIANT_GROUP_BOX.h,
            createdBy: input.createdBy,
          },
        ],
      },
      input.groupId,
    );
  }
  return { doc: next, frameId: input.id };
}
