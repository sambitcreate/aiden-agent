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

export interface QueuedTelegramTurn {
  readonly lane: QueueLane;
  readonly text: string;
  readonly chatId: number;
  readonly fromUsername?: string;
}

export interface TelegramQueueDependencies {
  isActive(): boolean;
  hasPendingDispatch(): boolean;
}

export function createTelegramQueue(deps: TelegramQueueDependencies) {
  const control: QueuedTelegramTurn[] = [];
  const priority: QueuedTelegramTurn[] = [];
  const def: QueuedTelegramTurn[] = [];

  function enqueue(turn: QueuedTelegramTurn): void {
    switch (turn.lane) {
      case "control": control.push(turn); break;
      case "priority": priority.push(turn); break;
      default: def.push(turn); break;
    }
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

  /** Drain control messages without dispatch gates (commands bypass the LLM). */
  function drainControl(): QueuedTelegramTurn[] {
    return control.splice(0, control.length);
  }

  return { enqueue, dequeue, peek, size, isEmpty, clear, drainControl };
}

export interface TelegramQueue {
  enqueue(turn: QueuedTelegramTurn): void;
  dequeue(): QueuedTelegramTurn | null;
  peek(): QueuedTelegramTurn | null;
  size(): number;
  isEmpty(): boolean;
  clear(): void;
  drainControl(): QueuedTelegramTurn[];
}

/** Classify an inbound message into a queue lane. */
export function classifyMessage(text: string): QueueLane {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return "control";
  return "default";
}
