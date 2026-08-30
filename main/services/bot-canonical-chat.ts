import type { ChatMeta } from "./types.js";

type CanonicalBotChatCandidate = Pick<ChatMeta, "id" | "createdAt" | "updatedAt">;

/**
 * Choose one persistent chat for a Bot without deleting legacy duplicates.
 * Newest visible activity wins; creation time and stable identity make ties
 * deterministic across restarts and independently ordered store reads.
 */
export function selectCanonicalBotChat<Chat extends CanonicalBotChatCandidate>(
  chats: readonly Chat[],
): Chat | undefined {
  let selected: Chat | undefined;
  for (const candidate of chats) {
    if (
      !selected ||
      candidate.updatedAt > selected.updatedAt ||
      (candidate.updatedAt === selected.updatedAt &&
        (candidate.createdAt > selected.createdAt ||
          (candidate.createdAt === selected.createdAt && candidate.id < selected.id)))
    ) {
      selected = candidate;
    }
  }
  return selected;
}
