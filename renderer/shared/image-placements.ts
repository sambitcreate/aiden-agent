// Which call produced each image of a reply. Shared by the desktop transcript
// and the Remote projection, so every client places an image at the same row.

import { isToolStep, type GenerationTimeline } from "./generation-timeline.js";
import { isVisualSnapshotAttachmentId } from "./visual-snapshots.js";

const IMAGE_PRODUCING_TOOLS = new Set(["generate_image", "display_image", "share_image"]);
/** share_image attachment ids; every other assistant image came from the display path. */
const SHARED_IMAGE_ID_PREFIX = "shared_";

/**
 * Replies saved before every image recorded its producing call keep shown and
 * shared images unplaced, so they would all trail the reply. Infer a call for
 * them only when the pairing is unambiguous: within each source (share_image,
 * or the display path that display_image and generate_image share), the
 * unplaced images must match that source's completed calls that own no image
 * one for one, and then pair in order. Any mismatch (a call that showed a
 * duplicate, a call with several images) infers nothing for that source.
 * Returns the stored placements plus any inferred ones.
 */
export function withInferredImagePlacements(
  timeline: GenerationTimeline | null | undefined,
  attachments: readonly { id: string; kind: string }[],
  placements: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (!timeline) return placements;
  const placedCalls = new Set(placements.values());
  const openCalls = { shared: [] as string[], displayed: [] as string[] };
  for (const step of timeline.steps) {
    if (!isToolStep(step) || step.status !== "completed" || !IMAGE_PRODUCING_TOOLS.has(step.toolName)) continue;
    if (placedCalls.has(step.toolCallId)) continue;
    (step.toolName === "share_image" ? openCalls.shared : openCalls.displayed).push(step.toolCallId);
  }
  const unplaced = { shared: [] as string[], displayed: [] as string[] };
  for (const attachment of attachments) {
    if (attachment.kind !== "image" || placements.has(attachment.id)) continue;
    // Visual snapshots come from visuals, never from an image call.
    if (isVisualSnapshotAttachmentId(attachment.id)) continue;
    (attachment.id.startsWith(SHARED_IMAGE_ID_PREFIX) ? unplaced.shared : unplaced.displayed).push(attachment.id);
  }
  let inferred: Map<string, string> | undefined;
  for (const source of ["shared", "displayed"] as const) {
    const ids = unplaced[source];
    const calls = openCalls[source];
    if (ids.length === 0 || ids.length !== calls.length) continue;
    inferred ??= new Map(placements);
    ids.forEach((id, index) => inferred!.set(id, calls[index]!));
  }
  return inferred ?? placements;
}
