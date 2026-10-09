import type { HtmlArtifactPlacementV1 } from "../../renderer/shared/chat-artifacts.js";

/**
 * Which render_artifact call produced each HTML artifact in one generation.
 * Pi hands extensions the provider's raw tool-call id, but the renderer-safe
 * timeline publishes its own `call-N` ids, so ids are translated on read
 * through the generation's timeline.
 */
export function createArtifactPlacementLedger() {
  const rawCallByMedia = new Map<string, string>();
  let resolve: (rawToolCallId: string) => string | undefined = () => undefined;
  const publicIdFor = (mediaId: string): string | undefined => {
    const raw = rawCallByMedia.get(mediaId);
    return raw === undefined ? undefined : resolve(raw);
  };
  return {
    /** First call wins: a same-title replace stays where the visual first appeared. */
    record(mediaId: string, rawToolCallId: string): void {
      if (!rawCallByMedia.has(mediaId)) rawCallByMedia.set(mediaId, rawToolCallId);
    },
    setResolver(resolver: (rawToolCallId: string) => string | undefined): void {
      resolve = resolver;
    },
    publicIdFor,
    placementsFor(artifacts: readonly { mediaId: string }[]): HtmlArtifactPlacementV1[] | undefined {
      const placements = artifacts.flatMap((artifact) => {
        const toolCallId = publicIdFor(artifact.mediaId);
        return toolCallId ? [{ mediaId: artifact.mediaId, toolCallId }] : [];
      });
      return placements.length ? placements : undefined;
    },
  };
}

export type ArtifactPlacementLedger = ReturnType<typeof createArtifactPlacementLedger>;
