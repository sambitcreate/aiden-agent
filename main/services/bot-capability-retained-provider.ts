import type { Chat } from "./types.js";

export interface BotRetainedProvider {
  sourceProviderId: string;
  sourceModelId: string;
}

/** Preserve only an exact persisted chat provider/model through bounded projection. */
export function retainedBotProviderForChat(
  chat: Pick<Chat, "providerId" | "model">,
): readonly BotRetainedProvider[] {
  return chat.providerId && chat.model
    ? [{ sourceProviderId: chat.providerId, sourceModelId: chat.model }]
    : [];
}
