import type { Attachment, ChatMessage } from "./types";
import type { SkillInvocationV1 } from "../shared/slash-commands";
import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../shared/chat-message-contract";
import {
  MAX_RUN_INPUT_TEXT,
  type ChatRunInputAdmissionResult,
  type ChatRunInputRejectionReason,
} from "../shared/chat-run-input";

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
  /** Set while a chat-wide operation (manual compaction) must finish before delivery. */
  holdReason?: "compaction";
  /**
   * Set while this chat is a fork whose summary is pending or failed. Main
   * refuses its sends until the summary is ready or the user continues
   * without it, so queued follow-ups wait here in order.
   */
  forkSummaryHeld?: boolean;
}

/** The subset of a compaction result that decides whether held follow-ups may proceed. */
export type CompactionHoldOutcome = { compacted: true } | { compacted: false; reason: string };

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
    this.publish({
      messages: [],
      paused: true,
      holdReason: this.snapshot.holdReason,
      forkSummaryHeld: this.snapshot.forkSummaryHeld,
    });
  }
  /** Follow the fork's summary state; releasing lets the queue continue in order. */
  holdForForkSummary(held: boolean) {
    if (Boolean(this.snapshot.forkSummaryHeld) === held) return;
    this.publish({ ...this.snapshot, forkSummaryHeld: held || undefined });
  }
  /** Accept follow-ups while compaction runs, but deliver none until it settles. */
  holdForCompaction() {
    this.publish({ ...this.snapshot, holdReason: "compaction" });
  }
  /**
   * Release the compaction hold. A finished (or unnecessary) compaction lets
   * the queue continue in order; anything else keeps every queued message and
   * pauses delivery so the user decides whether to send into the old context.
   * Returns true when queued messages were paused by this release.
   */
  releaseCompactionHold(outcome: CompactionHoldOutcome | undefined): boolean {
    if (this.snapshot.holdReason !== "compaction") return false;
    const proceed =
      outcome !== undefined &&
      (outcome.compacted ||
        outcome.reason === "already_compact" ||
        // Compaction never started because another turn owns the chat; the
        // queue already waits for that turn through its normal gates.
        outcome.reason === "busy");
    const pause = !proceed && this.snapshot.messages.length > 0;
    this.publish({
      ...this.snapshot,
      holdReason: undefined,
      paused: pause || this.snapshot.paused,
    });
    return pause;
  }
  claim(): QueuedChatMessage | undefined {
    if (
      this.snapshot.paused ||
      this.snapshot.holdReason ||
      this.snapshot.forkSummaryHeld ||
      this.snapshot.sendingId ||
      this.snapshot.editingId
    )
      return;
    const message = this.snapshot.messages[0];
    if (!message) return;
    this.publish({ ...this.snapshot, sendingId: message.id });
    return message;
  }
  /**
   * Claim one specific message for an explicit user action (Steer). Unlike
   * `claim()`, a paused or compaction-held queue does not block it, because
   * the user chose this message; an open edit or another in-flight send does.
   */
  claimById(id: string): QueuedChatMessage | undefined {
    if (this.snapshot.sendingId || this.snapshot.editingId === id) return;
    const message = this.snapshot.messages.find((item) => item.id === id);
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
      input.queue.getSnapshot().holdReason ||
      input.queue.getSnapshot().forkSummaryHeld ||
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

/** Steering carries plain text only; attachments, skills and visualize need a full turn. */
export function canSteerQueuedMessage(message: QueuedChatMessage): boolean {
  return (
    message.text.trim().length > 0 &&
    message.text.length <= MAX_RUN_INPUT_TEXT &&
    message.attachments.length === 0 &&
    !message.skillInvocation &&
    !message.options?.visualize
  );
}

/** User-facing copy for a steer that main did not write to the transcript. */
export function steerRejectionMessage(reason: ChatRunInputRejectionReason | undefined): string {
  switch (reason) {
    case "cancelled":
      return "Aiden is stopping this response, so it can't take guidance.";
    case "capacity":
      return "This response already has the maximum pending guidance. Queue it instead.";
    case "invalid":
      return "Steer accepts plain text only.";
    default:
      return "The current response has ended. Send your message normally.";
  }
}

/**
 * User-facing copy for run input main saved to the transcript but the run
 * never took (it ended, was stopped, or was full). iOS and Android show the
 * same receipts for the same Remote outcomes, so keep the three in step.
 */
export function committedRunInputNotice(reason: ChatRunInputRejectionReason | undefined): string {
  switch (reason) {
    case "cancelled":
      return "Saved to the chat — the run was cancelled before it could use it";
    case "capacity":
      return "Saved to the chat — the run queue was full";
    default:
      return "Saved to the chat — the run ended before it could use it";
  }
}

export type SteerQueuedMessageOutcome =
  /** Pi accepted the guidance; the transcript already shows it. */
  | { kind: "admitted" }
  /** Saved as conversation history, but the run ended before Pi accepted it. */
  | { kind: "committed"; reason?: ChatRunInputRejectionReason }
  /** Nothing was written; the message stays queued. */
  | { kind: "rejected"; reason?: ChatRunInputRejectionReason }
  /** The outcome is unknown; the message stays queued and the queue pauses. */
  | { kind: "unknown"; error: unknown }
  /** The message cannot be steered, or the queue is busy with it. */
  | { kind: "unavailable" };

/**
 * Send one queued message into the active run through main's run-input
 * admission. A committed receipt always removes the row, because main already
 * holds the message as history. An uncommitted rejection keeps it queued for
 * the normal follow-up path. An unknown outcome keeps it but pauses the queue,
 * so it is never auto-sent as a possible duplicate turn.
 */
export async function steerQueuedMessage(input: {
  queue: ChatMessageQueue;
  id: string;
  admit: (text: string) => Promise<ChatRunInputAdmissionResult>;
}): Promise<SteerQueuedMessageOutcome> {
  const candidate = input.queue.getSnapshot().messages.find((item) => item.id === input.id);
  if (!candidate || !canSteerQueuedMessage(candidate)) return { kind: "unavailable" };
  const message = input.queue.claimById(input.id);
  if (!message) return { kind: "unavailable" };
  let receipt: ChatRunInputAdmissionResult;
  try {
    receipt = await input.admit(message.text);
  } catch (error) {
    input.queue.settle(message.id, "failed");
    return { kind: "unknown", error };
  }
  if (receipt.committed) {
    input.queue.settle(message.id, "sent");
    return receipt.admitted ? { kind: "admitted" } : { kind: "committed", reason: receipt.reason };
  }
  input.queue.settle(message.id, "deferred");
  return { kind: "rejected", reason: receipt.reason };
}

/**
 * Show run input main already committed in the open chat right away, instead
 * of waiting for the running response to finish and reload the transcript.
 * Keyed by the committed message id, so a later reload never duplicates it.
 */
export function withCommittedRunInput<T extends { messages: ChatMessage[] }>(
  chat: T,
  committed: { messageId: string; text: string; createdAt: number },
): T {
  if (chat.messages.some((message) => message.id === committed.messageId)) return chat;
  return {
    ...chat,
    messages: [
      ...chat.messages,
      {
        id: committed.messageId,
        role: "user",
        content: committed.text,
        createdAt: committed.createdAt,
      },
    ],
  };
}
