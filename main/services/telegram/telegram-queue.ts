// Turn queue and dispatch gates for Telegram-originated prompts.
//
// Messages are classified into three lanes:
//   control  — operator commands (/start, /stop, /status) that always
//              jump the queue and bypass the LLM entirely.
//   priority — short, user-explicit messages that should dispatch next.
//   default  — normal prompts that wait their turn.
//
// Dispatch requires: no active turn AND no pending dispatch. This prevents
// overlapping generations on the persistent Telegram chat (the llmClient
// beginChatTurn admission gate is the hard backstop; this queue is the
// cooperative layer that avoids hammering it).
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

export type QueueLane = "control" | "priority" | "default";

import type { Attachment } from "../types.js";

export interface QueuedTelegramTurn {
  /** Process-local opaque id used by Telegram queue controls. */
  readonly id?: number;
  readonly lane: QueueLane;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  /** Telegram chat ID — used for API calls (sendMessage, sendChatAction). */
  readonly chatId: number;
  readonly sourceMessageId?: number;
  readonly sourceMediaGroupId?: string;
  readonly threadId?: number;
  /** Paired owner's Telegram user ID — used for the persistent Aiden chat key. */
  readonly ownerUserId: number;
  readonly fromUsername?: string;
  /** Workspace selection captured when the prompt was accepted. */
  readonly workspaceId?: string;
  readonly hasVoiceInput?: boolean;
}

export interface TelegramQueueDependencies {
  isActive(): boolean;
  hasPendingDispatch(): boolean;
}

export function createTelegramQueue(deps: TelegramQueueDependencies) {
  const control: QueuedTelegramTurn[] = [];
  const priority: QueuedTelegramTurn[] = [];
  const def: QueuedTelegramTurn[] = [];

  let nextId = 1;

  function enqueue(turn: QueuedTelegramTurn): QueuedTelegramTurn {
    const accepted = turn.id === undefined ? { ...turn, id: nextId++ } : turn;
    switch (accepted.lane) {
      case "control":
        control.push(accepted);
        break;
      case "priority":
        priority.push(accepted);
        break;
      default:
        def.push(accepted);
        break;
    }
    return accepted;
  }

  function size(): number {
    return control.length + priority.length + def.length;
  }

  function isEmpty(): boolean {
    return size() === 0;
  }

  /** Peek at the next dispatchable turn, or null if gates block or queue is empty. */
  function peek(): QueuedTelegramTurn | null {
    if (isEmpty()) return null;
    // Control lane always dispatches next.
    if (control.length > 0) return control[0]!;
    // Priority + default require idle host and no active dispatch.
    if (deps.isActive() || deps.hasPendingDispatch()) return null;
    if (priority.length > 0) return priority[0]!;
    return def[0] ?? null;
  }

  /** Dequeue the next dispatchable turn, or null if gates block. */
  function dequeue(): QueuedTelegramTurn | null {
    const next = peek();
    if (!next) return null;
    // Remove from the correct lane.
    if (control.length > 0 && control[0] === next) control.shift();
    else if (priority.length > 0 && priority[0] === next) priority.shift();
    else def.shift();
    return next;
  }

  function clear(): void {
    control.length = 0;
    priority.length = 0;
    def.length = 0;
  }

  function list(): readonly QueuedTelegramTurn[] {
    return [...control, ...priority, ...def];
  }

  function find(id: number): QueuedTelegramTurn | undefined {
    return list().find((turn) => turn.id === id);
  }

  function findBySource(chatId: number, messageId: number, threadId?: number): QueuedTelegramTurn | undefined {
    return list().find((turn) =>
      turn.chatId === chatId &&
      turn.sourceMessageId === messageId &&
      turn.threadId === threadId
    );
  }

  function remove(id: number): QueuedTelegramTurn | undefined {
    for (const lane of [control, priority, def]) {
      const index = lane.findIndex((turn) => turn.id === id);
      if (index >= 0) return lane.splice(index, 1)[0];
    }
    return undefined;
  }

  function setPriority(id: number, enabled: boolean): boolean {
    const item = remove(id);
    if (!item) return false;
    const replacement = { ...item, lane: enabled ? "priority" : "default" } as const;
    (enabled ? priority : def).push(replacement);
    return true;
  }

  function replace(id: number, replacement: QueuedTelegramTurn): boolean {
    const current = remove(id);
    if (!current) return false;
    enqueue({ ...replacement, id });
    return true;
  }

  /** Drain control messages without dispatch gates (commands bypass the LLM). */
  function drainControl(): QueuedTelegramTurn[] {
    return control.splice(0, control.length);
  }

  return { enqueue, dequeue, peek, size, isEmpty, clear, list, find, findBySource, remove, replace, setPriority, drainControl };
}

export interface TelegramQueue {
  enqueue(turn: QueuedTelegramTurn): QueuedTelegramTurn;
  dequeue(): QueuedTelegramTurn | null;
  peek(): QueuedTelegramTurn | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  list(): readonly QueuedTelegramTurn[];
  find(id: number): QueuedTelegramTurn | undefined;
  findBySource(chatId: number, messageId: number, threadId?: number): QueuedTelegramTurn | undefined;
  remove(id: number): QueuedTelegramTurn | undefined;
  replace(id: number, replacement: QueuedTelegramTurn): boolean;
  setPriority(id: number, enabled: boolean): boolean;
  drainControl(): QueuedTelegramTurn[];
}

/** Classify an inbound message into a queue lane. */
export function classifyMessage(text: string): QueueLane {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return "control";
  return "default";
}
