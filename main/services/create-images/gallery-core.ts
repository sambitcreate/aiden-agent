// Assembles the Create Images gallery (one workflow's history, or the library of
// every workflow) from the run ledger. Pure: lookups are passed in.
import { GALLERY_MAX_ITEMS, type GalleryItem } from "../../../renderer/shared/images/ipc-types.js";
import type { OutputRef } from "../../../renderer/shared/images/run-types.js";
import type { GeneratedAttempt } from "./run-ledger.js";

export interface GalleryImage {
  attempt: GeneratedAttempt;
  ref: OutputRef;
  index: number;
}

/**
 * The images to list, newest first by when their request finished (ties keep the ledger's
 * order). Each asset appears once, at its newest occurrence; images no longer in the asset store
 * are left out, since they cannot be shown.
 */
export function selectGalleryImages(
  attempts: readonly GeneratedAttempt[],
  options: { exists(assetId: string): boolean; limit?: number },
): GalleryImage[] {
  const limit = Math.min(options.limit ?? GALLERY_MAX_ITEMS, GALLERY_MAX_ITEMS);
  const ordered = attempts
    .map((attempt, position) => ({ attempt, position }))
    .sort((left, right) => right.attempt.finishedAt - left.attempt.finishedAt || left.position - right.position);
  const seen = new Set<string>();
  const images: GalleryImage[] = [];
  for (const { attempt } of ordered) {
    for (const [index, ref] of attempt.output.entries()) {
      if (images.length >= limit) return images;
      if (seen.has(ref.assetId) || !options.exists(ref.assetId)) continue;
      seen.add(ref.assetId);
      images.push({ attempt, ref, index });
    }
  }
  return images;
}

export interface GalleryLookups {
  workflowTitle(workflowId: string): string | undefined;
  nodeTitle(workflowId: string, nodeId: string): string | undefined;
  saved: ReadonlySet<string>;
  /** A document-bound thumbnail URL; an image without one is left out. */
  thumbUrl(assetId: string): string | undefined;
}

export function toGalleryItems(images: readonly GalleryImage[], lookups: GalleryLookups): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (const { attempt, ref, index } of images) {
    const thumbUrl = lookups.thumbUrl(ref.assetId);
    if (thumbUrl === undefined) continue;
    const workflowTitle = lookups.workflowTitle(attempt.workflowId);
    const nodeTitle = lookups.nodeTitle(attempt.workflowId, attempt.nodeId);
    items.push({
      assetId: ref.assetId,
      width: ref.width,
      height: ref.height,
      mediaType: ref.mediaType,
      runId: attempt.runId,
      workflowId: attempt.workflowId,
      ...(workflowTitle !== undefined ? { workflowTitle } : {}),
      nodeId: attempt.nodeId,
      ...(nodeTitle !== undefined ? { nodeTitle } : {}),
      variant: attempt.variant,
      index,
      provider: attempt.provider,
      model: attempt.model,
      ...(attempt.prompt !== undefined ? { prompt: attempt.prompt } : {}),
      createdAt: attempt.finishedAt,
      saved: lookups.saved.has(ref.assetId),
      thumbUrl,
    });
  }
  return items;
}
