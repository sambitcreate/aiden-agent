import type { ChatMessage } from "./types.js";
import type { ChatForkPosition } from "../../renderer/shared/chat-copy-contract.js";

/** Collects the artifact payload copied by a clone or fork in one bounded pass. */
export function selectedHtmlArtifactMediaIds(
  messages: readonly ChatMessage[],
  cut?: string | { messageId: string; position: ChatForkPosition },
): string[] {
  const boundary = typeof cut === "string" ? { messageId: cut, position: "after" as const } : cut;
  const mediaIds: string[] = [];
  let foundBoundary = boundary === undefined;

  for (const message of messages) {
    if (
      boundary?.position === "before" &&
      message.id === boundary.messageId &&
      message.role === "user"
    ) {
      foundBoundary = true;
      break;
    }
    for (const artifact of message.htmlArtifacts ?? []) mediaIds.push(artifact.mediaId);
    if (
      boundary?.position === "after" &&
      message.id === boundary.messageId &&
      message.role === "assistant"
    ) {
      foundBoundary = true;
      break;
    }
  }

  if (!foundBoundary) {
    throw new Error(
      boundary?.position === "before"
        ? "The selected message is no longer in this chat."
        : "The selected fork point is not a completed assistant turn.",
    );
  }
  return mediaIds;
}
