import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { isHtmlArtifactMediaId } from "../shared/generative-ui";

const SHA256 = /^[A-Fa-f0-9]{64}$/u;

/**
 * `artifact` remains the legacy revision-media query. `artifactId` pins that
 * media identity to its immutable content descriptor so the destination can
 * reject a stale or mismatched transcript link before selecting the screen.
 */
export interface DesignArtifactRouteSearch {
  artifact?: string;
  artifactId?: string;
}

export function parseDesignArtifactRouteSearch(
  search: Record<string, unknown>,
): DesignArtifactRouteSearch {
  if (
    typeof search.artifact !== "string" ||
    !search.artifact.startsWith("design:") ||
    !isHtmlArtifactMediaId(search.artifact)
  ) {
    return {};
  }
  if (!Object.prototype.hasOwnProperty.call(search, "artifactId")) {
    return { artifact: search.artifact };
  }
  if (typeof search.artifactId !== "string" || !SHA256.test(search.artifactId)) {
    return {};
  }
  return {
    artifact: search.artifact,
    artifactId: search.artifactId.toLowerCase(),
  };
}

export function designArtifactNavigationTarget(input: {
  legacyChatId: string;
  projectId?: string;
  artifact: Pick<ChatHtmlArtifactV1, "id" | "mediaId">;
}): { routeProjectId: string; search: Required<DesignArtifactRouteSearch> } {
  return {
    routeProjectId: input.projectId ?? input.legacyChatId,
    search: {
      artifact: input.artifact.mediaId,
      artifactId: input.artifact.id,
    },
  };
}
