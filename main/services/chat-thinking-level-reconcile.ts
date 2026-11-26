// A chat's own thinking level (an Agent Slider stop) can name a level its
// model no longer supports. Main clamps the request at generation time; this
// writes the level that really ran back to the chat, so the slider, ChatMeta
// and the next read agree with what was sent.

import type { GenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import type { ChatMetadataUpdatedPatch } from "../../renderer/shared/chat-metadata-update.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import type { Chat } from "./types.js";

export interface ChatThinkingLevelReconcileDeps {
  chatStore: {
    reconcileChatThinkingLevel(
      id: string,
      expected: { providerId: string; model: string; thinkingLevel: GenerationThinkingLevel },
      resolved: GenerationThinkingLevel,
    ): Promise<Chat | null>;
  };
  /** `chats:metadata-updated`, so open windows show the level that ran. */
  broadcast(update: ChatMetadataUpdatedPatch): void;
}

/**
 * Only an ordinary chat's own level is reconciled, and only when this turn
 * asked for exactly that level on the chat's own model. Everything else (a
 * per-model saved level, a Bot chat, a level the renderer overrode) is left
 * alone. The store's compare-and-set keeps a newer selection.
 */
export async function reconcileTurnThinkingLevel(
  deps: ChatThinkingLevelReconcileDeps,
  turn: {
    chat: Pick<Chat, "id" | "botId" | "providerId" | "model" | "thinkingLevel">;
    providerId: string;
    model: string;
    requested: GenerationThinkingLevel | undefined;
    resolved: GenerationThinkingLevel;
  },
): Promise<boolean> {
  const { chat } = turn;
  if (
    chat.botId ||
    !chat.thinkingLevel ||
    turn.requested !== chat.thinkingLevel ||
    turn.resolved === chat.thinkingLevel ||
    chat.providerId !== turn.providerId ||
    chat.model !== turn.model
  ) {
    return false;
  }
  const updated = await deps.chatStore.reconcileChatThinkingLevel(
    chat.id,
    { providerId: turn.providerId, model: turn.model, thinkingLevel: chat.thinkingLevel },
    turn.resolved,
  );
  if (!updated) return false;
  deps.broadcast({
    chatId: updated.id,
    title: updated.title,
    workspaceId: persistedChatWorkspaceId(updated.workspaceId),
    updatedAt: updated.updatedAt,
    thinkingLevel: updated.thinkingLevel ?? null,
  });
  return true;
}
