import type { ChatActivitySnapshot } from "../../renderer/shared/chat-activity.js";

export type ChatAttentionKind = "approval" | "input";

interface AttentionEntry {
  streamId: string;
  kind: ChatAttentionKind;
}

/**
 * Projects stream ownership into a small per-chat activity signal. Stream ids
 * make begin/settle idempotent while counts keep the contract safe if Aiden
 * later permits more than one kind of background work in the same chat.
 *
 * Attention prompts (tool approvals and ask-user questions) are keyed by their
 * prompt id and attributed to a chat through the stream that raised them. A
 * prompt raised by a stream the registry does not own (for example a child
 * stream) is ignored rather than guessed. Settling a stream withdraws every
 * prompt it still holds so a missed withdrawal cannot strand a row state.
 */
export class ChatActivityRegistry {
  private readonly streamChatIds = new Map<string, string>();
  private readonly activeStreamCounts = new Map<string, number>();
  private readonly attention = new Map<string, AttentionEntry>();
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
    let attentionChanged = false;
    for (const [promptId, entry] of this.attention) {
      if (entry.streamId !== streamId) continue;
      this.attention.delete(promptId);
      attentionChanged = true;
    }

    const count = this.activeStreamCounts.get(chatId) ?? 0;
    if (count > 1) {
      this.activeStreamCounts.set(chatId, count - 1);
      if (attentionChanged) this.publish();
      return;
    }
    this.activeStreamCounts.delete(chatId);
    this.publish();
  }

  /** Record a prompt that is now waiting on the user. */
  requestAttention(promptId: string, streamId: string, kind: ChatAttentionKind): void {
    if (!this.streamChatIds.has(streamId)) return;
    const existing = this.attention.get(promptId);
    if (existing?.streamId === streamId && existing.kind === kind) return;
    const before = this.attentionKey();
    this.attention.set(promptId, { streamId, kind });
    if (this.attentionKey() !== before) this.publish();
  }

  /** Withdraw a prompt once it was answered, cancelled, or detached. */
  resolveAttention(promptId: string): void {
    if (!this.attention.has(promptId)) return;
    const before = this.attentionKey();
    this.attention.delete(promptId);
    if (this.attentionKey() !== before) this.publish();
  }

  snapshot(): ChatActivitySnapshot {
    const approval = new Set<string>();
    const input = new Set<string>();
    for (const entry of this.attention.values()) {
      const chatId = this.streamChatIds.get(entry.streamId);
      if (chatId === undefined) continue;
      (entry.kind === "approval" ? approval : input).add(chatId);
    }
    return {
      revision: this.revision,
      activeChatIds: [...this.activeStreamCounts.keys()],
      ...(approval.size > 0 ? { approvalChatIds: [...approval] } : {}),
      ...(input.size > 0 ? { inputChatIds: [...input] } : {}),
    };
  }

  /** Only chat-level attention changes are observable; extra prompts in one chat are not. */
  private attentionKey(): string {
    const snapshot = this.snapshot();
    return JSON.stringify([
      [...(snapshot.approvalChatIds ?? [])].sort(),
      [...(snapshot.inputChatIds ?? [])].sort(),
    ]);
  }

  private publish(): void {
    this.revision += 1;
    this.onChange(this.snapshot());
  }
}
