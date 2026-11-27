// Visuals Aiden draws with `render_artifact` while design mode is on also land
// on the canvas (design mode P3b). Pure, so the rule is tested on its own;
// llm-client runs it once the turn's artifacts are committed.

import { canvasView } from "../../../renderer/shared/design-canvas/canvas-summary.js";
import { landedPageId, withLazyClaim } from "../../../renderer/shared/design-canvas/chat-pages.js";
import { claimWithRoom } from "./lazy-claim.js";
import { placeFrame } from "../../../renderer/shared/design-canvas/placement.js";
import { DESIGN_CANVAS_LIMITS, type DesignCanvas } from "../../../renderer/shared/design-canvas/schema.js";
import type { DesignChatView } from "../../../renderer/shared/design-canvas/view.js";
import type { DesignCanvasUpdated, DesignChatCanvases } from "./store.js";
import type { DesignTurnPages } from "./views.js";

/** An artifact frame's box when it first lands, in canvas units. */
export const ARTIFACT_FRAME_BOX = { w: 640, h: 480 } as const;

export type CanvasArtifact = { mediaId: string; title: string };

/**
 * Puts one turn's artifacts on the canvas, on the page the chat's turn works
 * on. One already there (same `mediaId`) is left alone. An artifact titled
 * like an unlocked frame Aiden placed before for this same chat on that page
 * replaces that frame's media and keeps where the person put it; a locked
 * frame, one on another page, or one another chat drew is never swapped. Two
 * visuals of one turn never share a frame, even under one title. The rest are
 * placed beside the frames in view, stamped with the chat that drew them.
 * Returns `changed: false` when nothing moved, so the caller saves and
 * broadcasts only real changes.
 */
export function placeArtifactFrames(
  doc: DesignCanvas,
  artifacts: readonly CanvasArtifact[],
  newId: () => string,
  /** The chat that drew them, and its view for the turn (`designTurnPages`). */
  place: { chatId: string; view: DesignChatView },
): { doc: DesignCanvas; changed: boolean } {
  const { chatId, view } = place;
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
        frame.chatId === chatId &&
        frame.pageId === view.pageId &&
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
      { kind: "artifact", title, mediaId: artifact.mediaId, chatId, pageId: view.pageId, createdBy: "aiden", ...ARTIFACT_FRAME_BOX },
      canvasView(next, view),
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

/** What a placement needs to reach the chat's workspace canvas and the page its turn works on. */
type CanvasPlacement = {
  chatId: string;
  store: Pick<DesignChatCanvases, "update" | "workspaceIdOf">;
  /** The turn's page resolver (`designTurnPages`). */
  pages: Pick<DesignTurnPages, "resolver">;
  broadcast(update: DesignCanvasUpdated): void;
  newId(): string;
  /** Settles once a design-mode entry running for this chat has claimed its page. */
  pendingEntry?(): Promise<void>;
  /** Which claimed chats are live, asked only when the lazy claim finds `chatPages` full. */
  isLive?(chatIds: string[], workspaceId: string): Promise<Set<string>>;
};

/**
 * The chat's workspace, resolved once so the save and the broadcast name the
 * same one, and the turn's view resolver for it. Waits for a pending entry
 * first, so a placement's lazy claim never comes before entry's claim.
 */
async function placementTurn(input: CanvasPlacement): Promise<{ workspaceId: string; viewOf: (doc: DesignCanvas) => DesignChatView }> {
  await input.pendingEntry?.();
  const workspaceId = await input.store.workspaceIdOf(input.chatId);
  if (workspaceId === null) throw new Error("This chat is no longer available.");
  return { workspaceId, viewOf: await input.pages.resolver(workspaceId) };
}

/**
 * Places the artifacts in the chat's workspace canvas and tells open
 * canvases. Saves nothing (and announces nothing) when every artifact is
 * already there. A chat with no page of its own claims the turn's page.
 */
export async function placeArtifactsOnCanvas(input: CanvasPlacement & { artifacts: readonly CanvasArtifact[] }): Promise<boolean> {
  if (input.artifacts.length === 0) return false;
  try {
    const { workspaceId, viewOf } = await placementTurn(input);
    let landed: string | undefined;
    const { doc: saved } = await input.store.update(
      input.chatId,
      (doc) => {
        const view = viewOf(doc);
        const placed = placeArtifactFrames(doc, input.artifacts, input.newId, { chatId: input.chatId, view });
        if (!placed.changed) throw UNCHANGED;
        landed = landedPageId(doc, placed.doc, view.pageId);
        return withLazyClaim(placed.doc, input.chatId, landed);
      },
      { workspaceId },
    );
    input.broadcast({ workspaceId, chatId: input.chatId, revision: saved.revision });
    await claimWithRoom({ ...input, workspaceId, pageId: landed, saved });
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
 * image frame sized to its shape, on the page the turn works on (`view`). An
 * image already shown on that page (same path) keeps its frame, which now
 * shows the new file. Returns the frame showing each image, in order, as far
 * as the canvas had room.
 */
export function placeImageFrames(
  doc: DesignCanvas,
  images: readonly CanvasImage[],
  newId: () => string,
  /** The chat's view for the turn (`designTurnPages`). */
  view: DesignChatView,
): { doc: DesignCanvas; changed: boolean; frameIds: string[] } {
  let next = doc;
  let changed = false;
  const frameIds: string[] = [];
  for (const image of images) {
    const shown = next.frames.find(
      (frame) => frame.kind === "image" && frame.path === image.path && frame.pageId === view.pageId,
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
        pageId: view.pageId,
        createdBy: "aiden",
        w: Math.max(1, image.width * scale),
        h: Math.max(1, image.height * scale),
      },
      canvasView(next, view),
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
 * Places saved images in the chat's workspace canvas and tells open canvases,
 * claiming the turn's page for a chat with none.
 * Returns the frames showing them and the page they are on, or null when
 * `shouldSave` refused under the canvas lock (design mode went off, or the
 * workspace changed).
 */
export async function placeImagesOnCanvas(
  input: CanvasPlacement & {
    images: readonly CanvasImage[];
    /** Checked again just before the canvas is written. */
    shouldSave?: () => Promise<boolean>;
  },
): Promise<{ frameIds: string[]; pageId: string } | null> {
  let frameIds: string[] = [];
  let pageId = "";
  let refused = false;
  let landed: string | undefined;
  const { workspaceId, viewOf } = await placementTurn(input);
  try {
    const { doc: saved } = await input.store.update(
      input.chatId,
      (doc) => {
        const view = viewOf(doc);
        pageId = view.pageId;
        if (input.images.length === 0) throw UNCHANGED;
        const placed = placeImageFrames(doc, input.images, input.newId, view);
        frameIds = placed.frameIds;
        if (!placed.changed) throw UNCHANGED;
        landed = landedPageId(doc, placed.doc, view.pageId);
        return withLazyClaim(placed.doc, input.chatId, landed);
      },
      {
        workspaceId,
        ...(input.shouldSave
          ? {
              beforeWrite: async () => {
                if (!(await input.shouldSave!())) {
                  refused = true;
                  throw UNCHANGED;
                }
              },
            }
          : {}),
      },
    );
    input.broadcast({ workspaceId, chatId: input.chatId, revision: saved.revision });
    await claimWithRoom({ ...input, workspaceId, pageId: landed, saved });
    return { frameIds, pageId };
  } catch (error) {
    if (error !== UNCHANGED) throw error;
    return refused ? null : { frameIds, pageId };
  }
}
