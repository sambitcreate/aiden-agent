import {
  sameChatHtmlArtifactDescriptor,
  type ChatHtmlArtifactV1,
} from "../../renderer/shared/chat-artifacts.js";
import type { chatStore } from "./chat-store.js";

type DirectEditChatStore = Pick<typeof chatStore, "appendMessage" | "get">;

export function createDesignDirectEditMessagePort(store: DirectEditChatStore) {
  return {
    async ensureArtifactMessage(input: {
      chatId: string;
      artifact: ChatHtmlArtifactV1;
      createdAt: number;
      model?: string;
    }): Promise<void> {
      const chat = await store.get(input.chatId);
      if (!chat) throw new Error("The Design Project chat was not found.");
      const prior = chat.messages
        .flatMap((message) => message.htmlArtifacts ?? [])
        .find(({ mediaId }) => mediaId === input.artifact.mediaId);
      if (prior) {
        if (!sameChatHtmlArtifactDescriptor(prior, input.artifact)) {
          throw new Error("The direct-edit artifact identity conflicts with chat history.");
        }
        return;
      }
      await store.appendMessage(input.chatId, {
        role: "assistant",
        content: "",
        htmlArtifacts: [input.artifact],
        createdAt: input.createdAt,
        ...(input.model ? { model: input.model } : {}),
      });
    },
  };
}
