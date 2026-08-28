import type { ChatMessage } from "./types.js";

/** Collects the artifact payload copied by a clone or fork in one bounded pass. */
export function selectedHtmlArtifactMediaIds(
  messages: readonly ChatMessage[],
  throughAssistantMessageId?: string,
): string[] {
  const mediaIds: string[] = [];
  let foundBoundary = throughAssistantMessageId === undefined;

  for (const message of messages) {
    for (const artifact of message.htmlArtifacts ?? []) mediaIds.push(artifact.mediaId);
    if (
      throughAssistantMessageId !== undefined &&
      message.id === throughAssistantMessageId &&
      message.role === "assistant"
    ) {
      foundBoundary = true;
      break;
    }
  }

  if (!foundBoundary) {
    throw new Error("The selected fork point is not a completed assistant turn.");
  }
  return mediaIds;
}
