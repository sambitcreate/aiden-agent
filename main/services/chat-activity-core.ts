import type { ChatActivitySnapshot } from "../../renderer/shared/chat-activity.js";

/**
 * Projects stream ownership into a small per-chat activity signal. Stream ids
 * make begin/settle idempotent while counts keep the contract safe if Aiden
 * later permits more than one kind of background work in the same chat.
 */
export class ChatActivityRegistry {
  private readonly streamChatIds = new Map<string, string>();
  private readonly activeStreamCounts = new Map<string, number>();
  private revision = 0;

  constructor(private readonly onChange: (snapshot: ChatActivitySnapshot) => void) {}

  begin(streamId: string, chatId: string): void {
    const existingChatId = this.streamChatIds.get(streamId);
    if (existingChatId === chatId) return;
    if (existingChatId !== undefined) this.settle(streamId);

    this.streamChatIds.set(streamId, chatId);
    const count = this.activeStreamCounts.get(chatId) ?? 0;
    this.activeStreamCounts.set(chatId, count + 1);
    if (count === 0) this.publish();
  }

  settle(streamId: string): void {
    const chatId = this.streamChatIds.get(streamId);
    if (chatId === undefined) return;
    this.streamChatIds.delete(streamId);

    const count = this.activeStreamCounts.get(chatId) ?? 0;
    if (count > 1) {
      this.activeStreamCounts.set(chatId, count - 1);
      return;
    }
    this.activeStreamCounts.delete(chatId);
    this.publish();
  }

  snapshot(): ChatActivitySnapshot {
    return {
      revision: this.revision,
      activeChatIds: [...this.activeStreamCounts.keys()],
    };
  }

  private publish(): void {
    this.revision += 1;
    this.onChange(this.snapshot());
  }
}
