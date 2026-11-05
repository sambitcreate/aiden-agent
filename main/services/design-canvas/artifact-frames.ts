// Visuals Aiden draws with `render_artifact` while design mode is on also land
// on the canvas (design mode P3b). Pure, so the rule is tested on its own;
// llm-client runs it once the turn's artifacts are committed.

import { canvasView } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { placeFrame } from "../../../renderer/shared/design-canvas/placement.js";
import { DESIGN_CANVAS_LIMITS, type DesignCanvasV1 } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignCanvasStore } from "./store.js";

/** An artifact frame's box when it first lands, in canvas units. */
export const ARTIFACT_FRAME_BOX = { w: 640, h: 480 } as const;

export type CanvasArtifact = { mediaId: string; title: string };

/**
 * Puts each artifact on the canvas. One already there (same `mediaId`) is
 * left alone. An artifact titled like a frame Aiden placed before replaces
 * that frame's media and keeps where the person put it; the rest are placed
 * beside the frames in view. Returns `changed: false` when nothing moved, so
 * the caller saves and broadcasts only real changes.
 */
export function placeArtifactFrames(
  doc: DesignCanvasV1,
  artifacts: readonly CanvasArtifact[],
  newId: () => string,
): { doc: DesignCanvasV1; changed: boolean } {
  let next = doc;
  let changed = false;
  for (const artifact of artifacts) {
    if (next.frames.some((frame) => frame.kind === "artifact" && frame.mediaId === artifact.mediaId)) continue;
    const title = artifact.title.trim().slice(0, DESIGN_CANVAS_LIMITS.titleChars) || "Visual";
    let sameTitle = -1;
    next.frames.forEach((frame, index) => {
      if (frame.kind === "artifact" && frame.createdBy === "aiden" && frame.title === title) sameTitle = index;
    });
    if (sameTitle >= 0) {
      const frames = next.frames.slice();
      frames[sameTitle] = { ...frames[sameTitle]!, mediaId: artifact.mediaId };
      next = { ...next, frames };
      changed = true;
      continue;
    }
    const placed = placeFrame(
      next,
      { kind: "artifact", title, mediaId: artifact.mediaId, createdBy: "aiden", ...ARTIFACT_FRAME_BOX },
      canvasView(next),
      newId,
    );
    // A full canvas takes no more frames; the visual is still in the chat.
    if ("error" in placed) break;
    next = placed.doc;
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
}): Promise<boolean> {
  if (input.artifacts.length === 0) return false;
  try {
    const saved = await input.store.update(input.chatId, (doc) => {
      const placed = placeArtifactFrames(doc, input.artifacts, input.newId);
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
