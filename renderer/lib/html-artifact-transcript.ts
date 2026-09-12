import type { ChatMessage } from "./types";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { isDesignHtmlArtifact } from "../shared/design-workspace";

export interface HtmlArtifactTranscriptEntry {
  key: string;
  anchor: string;
  artifact: ChatHtmlArtifactV1;
  source: "persisted" | "live";
}

/** Keep artifact keys in one transcript sibling list across stream handoff. */
export function htmlArtifactTranscriptPlan(
  messages: readonly ChatMessage[],
  liveArtifacts: readonly ChatHtmlArtifactV1[],
  streamingRowVisible: boolean,
  persistedDesignMediaIds?: ReadonlySet<string>,
): HtmlArtifactTranscriptEntry[] {
  const liveMediaIds = new Set(liveArtifacts.map((artifact) => artifact.mediaId));
  const entries: HtmlArtifactTranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const artifact of message.htmlArtifacts ?? []) {
      if (streamingRowVisible && liveMediaIds.has(artifact.mediaId)) continue;
      if (
        persistedDesignMediaIds &&
        isDesignHtmlArtifact(artifact) &&
        !persistedDesignMediaIds.has(artifact.mediaId)
      ) {
        continue;
      }
      entries.push({
        key: `html:${artifact.mediaId}`,
        anchor: `message:${message.id}`,
        artifact,
        source: "persisted",
      });
    }
  }
  if (streamingRowVisible) {
    for (const artifact of liveArtifacts) {
      entries.push({
        key: `html:${artifact.mediaId}`,
        anchor: "streaming",
        artifact,
        source: "live",
      });
    }
  }
  return entries;
}
