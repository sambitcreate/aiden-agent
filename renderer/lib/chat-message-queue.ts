import type { Attachment } from "./types";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../shared/chat-message-contract";

export interface QueuedChatMessage {
  id: string;
  text: string;
  attachments: Attachment[];
  skillInvocation?: SkillInvocationV1;
  options?: { visualize?: boolean };
}

interface QueueSnapshot {
  messages: readonly QueuedChatMessage[];
  paused: boolean;
  sendingId?: string;
  editingId?: string;
}

/** Unsent, document-local drafts. Never write attachment contents to browser storage. */
export class ChatMessageQueue {
  private snapshot: QueueSnapshot = { messages: [], paused: false };
  private listeners = new Set<() => void>();
  getSnapshot = (): QueueSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: QueueSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private validate(message: QueuedChatMessage) {
    if (!message.text.trim() && message.attachments.length === 0) {
      throw new Error("Add a message or an attachment before saving.");
    }
    if (new TextEncoder().encode(message.text).byteLength > MAX_CHAT_MESSAGE_CONTENT_BYTES) {
      throw new Error("Message text exceeds the 1 MB limit.");
    }
    const others = this.snapshot.messages.filter((item) => item.id !== message.id);
    if (others.length >= 20) throw new Error("The queue is full. Send or remove a message first.");
    // Bound retained inline attachment data across this chat, including base64 overhead.
    if (JSON.stringify([...others, message]).length > 32 * 1024 * 1024) {
      throw new Error("The queue is full. Send or remove attachments before adding more.");
    }
  }
  add(message: QueuedChatMessage) {
    if (this.snapshot.messages.some((item) => item.id === message.id)) return;
    this.validate(message);
    this.publish({
      ...this.snapshot,
      messages: [...this.snapshot.messages, structuredClone(message)],
    });
  }
  edit(id: string): boolean {
    if (this.snapshot.sendingId || !this.snapshot.messages.some((item) => item.id === id))
      return false;
    this.publish({ ...this.snapshot, editingId: id });
    return true;
  }
  closeEditor() {
    this.publish({ ...this.snapshot, editingId: undefined });
  }
  update(message: QueuedChatMessage) {
    if (this.snapshot.editingId !== message.id || this.snapshot.sendingId) return;
    this.validate(message);
    this.publish({
      ...this.snapshot,
      messages: this.snapshot.messages.map((item) =>
        item.id === message.id ? structuredClone(message) : item,
      ),
      editingId: undefined,
    });
  }
  remove(id: string) {
    if (this.snapshot.sendingId === id) return;
    this.publish({
      ...this.snapshot,
      messages: this.snapshot.messages.filter((item) => item.id !== id),
      editingId: this.snapshot.editingId === id ? undefined : this.snapshot.editingId,
    });
  }
  move(id: string, to: number) {
    if (this.snapshot.sendingId) return;
    const messages = [...this.snapshot.messages];
    const from = messages.findIndex((item) => item.id === id);
    if (from < 0 || to < 0 || to >= messages.length) return;
    const [message] = messages.splice(from, 1);
    messages.splice(to, 0, message);
    this.publish({ ...this.snapshot, messages });
  }
  pause() {
    this.publish({ ...this.snapshot, paused: true });
  }
  resume() {
    this.publish({ ...this.snapshot, paused: false });
  }
  discard() {
    this.publish({ messages: [], paused: true });
  }
  claim(): QueuedChatMessage | undefined {
    if (this.snapshot.paused || this.snapshot.sendingId || this.snapshot.editingId) return;
    const message = this.snapshot.messages[0];
    if (!message) return;
    this.publish({ ...this.snapshot, sendingId: message.id });
    return message;
  }
  settle(id: string, outcome: "sent" | "failed" | "deferred") {
    if (this.snapshot.sendingId !== id) return;
    this.publish({
      ...this.snapshot,
      sendingId: undefined,
      messages:
        outcome === "sent"
          ? this.snapshot.messages.filter((item) => item.id !== id)
          : this.snapshot.messages,
      paused: outcome === "failed" || this.snapshot.paused,
    });
  }
}

const queues = new Map<string, ChatMessageQueue>();
export function chatMessageQueue(chatId: string): ChatMessageQueue {
  let queue = queues.get(chatId);
  if (!queue) {
    queue = new ChatMessageQueue();
    queues.set(chatId, queue);
  }
  return queue;
}

export function discardChatMessageQueue(chatId: string) {
  queues.get(chatId)?.discard();
  queues.delete(chatId);
}

/** Claim synchronously, then recheck route/readiness after main's persistence barrier. */
export async function deliverQueuedMessage(input: {
  queue: ChatMessageQueue;
  isCurrent: () => boolean;
  waitUntilIdle: () => Promise<boolean>;
  send: (message: QueuedChatMessage) => Promise<void>;
  isUnknownAppend: (error: unknown) => boolean;
  onError: (error: unknown) => void;
}) {
  const message = input.queue.claim();
  if (!message) return;
  try {
    const idle = await input.waitUntilIdle();
    if (
      !input.isCurrent() ||
      input.queue.getSnapshot().paused ||
      input.queue.getSnapshot().sendingId !== message.id
    ) {
      input.queue.settle(message.id, "deferred");
      return;
    }
    if (!idle)
      throw new Error("The previous response is still saving. Resume the queue to try again.");
    await input.send(message);
    input.queue.settle(message.id, "sent");
  } catch (error) {
    // An uncertain append may already be durable: never offer it for replay.
    if (input.isUnknownAppend(error)) {
      input.queue.pause();
      input.queue.settle(message.id, "sent");
    } else {
      input.queue.settle(message.id, "failed");
    }
    input.onError(error);
  }
}
