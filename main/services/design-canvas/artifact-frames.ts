// Visuals Aiden draws with `render_artifact` while design mode is on also land
// on the canvas (design mode P3b). Pure, so the rule is tested on its own;
// llm-client runs it once the turn's artifacts are committed.

import { canvasView } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { placeFrame } from "../../../renderer/shared/design-canvas/placement.js";
import { DESIGN_CANVAS_LIMITS, type DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignCanvasStore } from "./store.js";

/** An artifact frame's box when it first lands, in canvas units. */
export const ARTIFACT_FRAME_BOX = { w: 640, h: 480 } as const;

export type CanvasArtifact = { mediaId: string; title: string };

/**
 * Puts one turn's artifacts on the canvas. One already there (same `mediaId`)
 * is left alone. An artifact titled like an unlocked frame Aiden placed before
 * on the page on screen replaces that frame's media and keeps where the person
 * put it; a locked frame, or one on another page, is never swapped. Two visuals
 * of one turn never share a frame, even under one title. The rest are placed
 * beside the frames in view. Returns `changed: false` when nothing moved, so
 * the caller saves and broadcasts only real changes.
 */
export function placeArtifactFrames(
  doc: DesignCanvas,
  artifacts: readonly CanvasArtifact[],
  newId: () => string,
  /** The canvas region's size on the person's screen, when their message said it. */
  viewSize?: { w: number; h: number },
): { doc: DesignCanvas; changed: boolean } {
  let next = doc;
  let changed = false;
  // Frames this turn already filled, so a second visual never lands in the first one's frame.
  const filled = new Set<string>();
  for (const artifact of artifacts) {
    if (next.frames.some((frame) => frame.kind === "artifact" && frame.mediaId === artifact.mediaId)) continue;
    const title = artifact.title.trim().slice(0, DESIGN_CANVAS_LIMITS.titleChars) || "Visual";
    let sameTitle = -1;
    next.frames.forEach((frame, index) => {
      if (
        frame.kind === "artifact" &&
        frame.createdBy === "aiden" &&
        frame.title === title &&
        !frame.locked &&
        frame.pageId === next.activePageId &&
        !filled.has(frame.id)
      ) {
        sameTitle = index;
      }
    });
    if (sameTitle >= 0) {
      const frames = next.frames.slice();
      frames[sameTitle] = { ...frames[sameTitle]!, mediaId: artifact.mediaId };
      filled.add(frames[sameTitle]!.id);
      next = { ...next, frames };
      changed = true;
      continue;
    }
    const placed = placeFrame(
      next,
      { kind: "artifact", title, mediaId: artifact.mediaId, createdBy: "aiden", ...ARTIFACT_FRAME_BOX },
      canvasView(next, viewSize),
      newId,
    );
    // A full canvas takes no more frames; the visual is still in the chat.
    if ("error" in placed) break;
    next = placed.doc;
    filled.add(placed.id);
    changed = true;
  }
  return { doc: next, changed };
}

const UNCHANGED = Symbol("unchanged");

/**
 * Places the artifacts in the chat's stored canvas and tells open canvases.
 * Saves nothing (and announces nothing) when every artifact is already there.
 */
export async function placeArtifactsOnCanvas(input: {
  chatId: string;
  artifacts: readonly CanvasArtifact[];
  store: Pick<DesignCanvasStore, "update">;
  broadcast(update: { chatId: string; revision: number }): void;
  newId(): string;
  /** The canvas region's size on the person's screen, when their message said it. */
  viewSize?: { w: number; h: number };
}): Promise<boolean> {
  if (input.artifacts.length === 0) return false;
  try {
    const saved = await input.store.update(input.chatId, (doc) => {
      const placed = placeArtifactFrames(doc, input.artifacts, input.newId, input.viewSize);
      if (!placed.changed) throw UNCHANGED;
      return placed.doc;
    });
    input.broadcast({ chatId: input.chatId, revision: saved.revision });
    return true;
  } catch (error) {
    if (error === UNCHANGED) return false;
    throw error;
  }
}

/** The longest side of a generated image's frame when it first lands, in canvas units. */
export const IMAGE_FRAME_LONG_SIDE = 480;

export type CanvasImage = { path: string; width: number; height: number };

/**
 * Puts images generate_image saved in the workspace on the canvas, each in an
 * image frame sized to its shape. An image already shown on the page on screen
 * (same path) keeps its frame, which now shows the new file. Returns the frame
 * showing each image, in order, as far as the canvas had room.
 */
export function placeImageFrames(
  doc: DesignCanvas,
  images: readonly CanvasImage[],
  newId: () => string,
  /** The canvas region's size on the person's screen, when their message said it. */
  viewSize?: { w: number; h: number },
): { doc: DesignCanvas; changed: boolean; frameIds: string[] } {
  let next = doc;
  let changed = false;
  const frameIds: string[] = [];
  for (const image of images) {
    const shown = next.frames.find(
      (frame) => frame.kind === "image" && frame.path === image.path && frame.pageId === next.activePageId,
    );
    if (shown) {
      frameIds.push(shown.id);
      continue;
    }
    const scale = IMAGE_FRAME_LONG_SIDE / Math.max(image.width, image.height, 1);
    const name = image.path.slice(image.path.lastIndexOf("/") + 1);
    const placed = placeFrame(
      next,
      {
        kind: "image",
        title: name.slice(0, DESIGN_CANVAS_LIMITS.titleChars) || "Image",
        path: image.path,
        createdBy: "aiden",
        w: Math.max(1, image.width * scale),
        h: Math.max(1, image.height * scale),
      },
      canvasView(next, viewSize),
      newId,
    );
    // A full canvas takes no more frames; the image is still in the workspace.
    if ("error" in placed) break;
    next = placed.doc;
    frameIds.push(placed.id);
    changed = true;
  }
  return { doc: next, changed, frameIds };
}

/**
 * Places saved images in the chat's stored canvas and tells open canvases.
 * Returns the frames showing them, or null when `shouldSave` refused under
 * the canvas lock (design mode went off, or the workspace changed).
 */
export async function placeImagesOnCanvas(input: {
  chatId: string;
  images: readonly CanvasImage[];
  store: Pick<DesignCanvasStore, "update">;
  broadcast(update: { chatId: string; revision: number }): void;
  newId(): string;
  viewSize?: { w: number; h: number };
  /** Checked again just before the canvas is written. */
  shouldSave?: () => Promise<boolean>;
}): Promise<string[] | null> {
  if (input.images.length === 0) return [];
  let frameIds: string[] = [];
  let refused = false;
  try {
    const saved = await input.store.update(
      input.chatId,
      (doc) => {
        const placed = placeImageFrames(doc, input.images, input.newId, input.viewSize);
        frameIds = placed.frameIds;
        if (!placed.changed) throw UNCHANGED;
        return placed.doc;
      },
      input.shouldSave
        ? {
            beforeWrite: async () => {
              if (!(await input.shouldSave!())) {
                refused = true;
                throw UNCHANGED;
              }
            },
          }
        : undefined,
    );
    input.broadcast({ chatId: input.chatId, revision: saved.revision });
    return frameIds;
  } catch (error) {
    if (error !== UNCHANGED) throw error;
    return refused ? null : frameIds;
  }
}
