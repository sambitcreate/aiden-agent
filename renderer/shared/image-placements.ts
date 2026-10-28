// Which call produced each image of a reply. Shared by the desktop transcript
// and the Remote projection, so every client places an image at the same row.

import { isToolStep, type GenerationTimeline } from "./generation-timeline.js";
import { isVisualSnapshotAttachmentId } from "./visual-snapshots.js";

/** share_image attachment ids; every other assistant image came from the display path. */
const SHARED_IMAGE_ID_PREFIX = "shared_";

/**
 * Replies saved before every image recorded its producing call keep shown and
 * shared images unplaced, so they would all trail the reply. Infer a call for
 * them only when the pairing is unambiguous, per source: share_image calls take
 * `shared_` images, and display_image calls take the other images. Each
 * source's unplaced images must match its completed calls that own no image
 * one for one, and then pair in order (image tools run one at a time, so saved
 * order is call order). generate_image calls never take part: their images
 * share the display path's ids, and any of its calls that owns no placed image
 * (an older reply, or a call that failed) makes the display source ambiguous,
 * so it infers nothing. Any other mismatch (a call that showed a duplicate)
 * infers nothing for that source. Returns the stored placements plus any
 * inferred ones.
 */
export function withInferredImagePlacements(
  timeline: GenerationTimeline | null | undefined,
  attachments: readonly { id: string; kind: string }[],
  placements: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (!timeline) return placements;
  const placedCalls = new Set(placements.values());
  const openCalls = { shared: [] as string[], displayed: [] as string[] };
  let unplacedGenerateCall = false;
  for (const step of timeline.steps) {
    if (!isToolStep(step) || placedCalls.has(step.toolCallId)) continue;
    if (step.toolName === "generate_image") unplacedGenerateCall = true;
    if (step.status !== "completed") continue;
    if (step.toolName === "share_image") openCalls.shared.push(step.toolCallId);
    else if (step.toolName === "display_image") openCalls.displayed.push(step.toolCallId);
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
    if (source === "displayed" && unplacedGenerateCall) continue;
    inferred ??= new Map(placements);
    ids.forEach((id, index) => inferred!.set(id, calls[index]!));
  }
  return inferred ?? placements;
}
