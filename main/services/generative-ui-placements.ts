import type {
  HtmlArtifactLayout,
  HtmlArtifactPlacementV1,
} from "../../renderer/shared/chat-artifacts.js";

/**
 * Which render_artifact call produced each HTML artifact in one generation.
 * Pi hands extensions the provider's raw tool-call id, but the renderer-safe
 * timeline publishes its own `call-N` ids, so ids are translated on read
 * through the generation's timeline.
 */
export function createArtifactPlacementLedger() {
  const rawCallByMedia = new Map<string, string>();
  const layoutByMedia = new Map<string, HtmlArtifactLayout>();
  let resolve: (rawToolCallId: string) => string | undefined = () => undefined;
  const publicIdFor = (mediaId: string): string | undefined => {
    const raw = rawCallByMedia.get(mediaId);
    return raw === undefined ? undefined : resolve(raw);
  };
  const layoutFor = (mediaId: string): HtmlArtifactLayout => layoutByMedia.get(mediaId) ?? "column";
  return {
    /**
     * First call wins the position: a same-title replace stays where the
     * visual first appeared. The latest call wins the layout, so a revision
     * can widen or narrow it.
     */
    record(mediaId: string, rawToolCallId: string, layout: HtmlArtifactLayout = "column"): void {
      if (!rawCallByMedia.has(mediaId)) rawCallByMedia.set(mediaId, rawToolCallId);
      layoutByMedia.set(mediaId, layout);
    },
    setResolver(resolver: (rawToolCallId: string) => string | undefined): void {
      resolve = resolver;
    },
    publicIdFor,
    layoutFor,
    placementsFor(artifacts: readonly { mediaId: string }[]): HtmlArtifactPlacementV1[] | undefined {
      const placements = artifacts.flatMap((artifact): HtmlArtifactPlacementV1[] => {
        const toolCallId = publicIdFor(artifact.mediaId);
        if (!toolCallId) return [];
        return [{
          mediaId: artifact.mediaId,
          toolCallId,
          ...(layoutFor(artifact.mediaId) === "wide" ? { layout: "wide" as const } : {}),
        }];
      });
      return placements.length ? placements : undefined;
    },
  };
}

export type ArtifactPlacementLedger = ReturnType<typeof createArtifactPlacementLedger>;
