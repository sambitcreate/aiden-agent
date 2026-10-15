// The hidden chat behind a design project. Main-minted with a pre-generated id
// (like Bot chats); never created through the renderer-owned chat path.
import type { createChatStore } from "../chat-store-core.js";
import type { Chat } from "../types.js";
import type { DesignChatPort } from "./store.js";

type ChatStoreLike = Pick<ReturnType<typeof createChatStore>, "get" | "create" | "appendMessage" | "list">;

export interface DesignChatAccess extends DesignChatPort {
  get(chatId: string): Promise<Chat | null>;
  appendUserMessage(
    chatId: string,
    input: { id: string; content: string; providerId: string; model: string; isCurrent: () => boolean },
  ): Promise<Chat>;
}

export function createDesignChatPort(deps: {
  chatStore: ChatStoreLike;
  /** Production uses chatApplicationService.remove, the crash-safe cascade. */
  remove(chatId: string): Promise<void>;
}): DesignChatAccess {
  return {
    get: (chatId) => deps.chatStore.get(chatId),
    async exists(chatId) {
      return (await deps.chatStore.get(chatId)) !== null;
    },
    async create(chatId, projectId) {
      await deps.chatStore.create({ id: chatId, owner: { kind: "design-project", projectId } });
    },
    remove: (chatId) => deps.remove(chatId),
    async ownedChatIds(projectId) {
      return (await deps.chatStore.list())
        .filter((chat) => chat.owner?.kind === "design-project" && chat.owner.projectId === projectId)
        .map((chat) => chat.id);
    },
    appendUserMessage: (chatId, input) =>
      deps.chatStore.appendMessage(
        chatId,
        { id: input.id, role: "user", content: input.content },
        { providerId: input.providerId, model: input.model, isCurrent: input.isCurrent },
      ),
  };
}
