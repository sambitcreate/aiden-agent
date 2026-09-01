import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import type { chatStore } from "./chat-store.js";

type DirectEditChatStore = Pick<typeof chatStore, "appendMessage" | "get">;

function exactArtifact(left: ChatHtmlArtifactV1, right: ChatHtmlArtifactV1): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.title === right.title &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.mediaId === right.mediaId
  );
}

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
        if (!exactArtifact(prior, input.artifact)) {
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
