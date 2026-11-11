import type { ChatOwedInputHold, OwedChatInput } from "./chat-run-input-admission.js";

export type { ChatOwedInputHold, OwedChatInput };

/** The chat's next turn, owed because its run ended before Pi read saved input. */
export interface OwedTurnPlan<Context, Origin extends string> {
  chatId: string;
  /** The run that ended without answering `inputs`. */
  settledStreamId: string;
  /** What the settling run ran with (provider, model, folder), for the owed turn. */
  context: Context;
  /** Saved input in the order it was committed; the last one is the turn's prompt. */
  inputs: OwedChatInput[];
  /**
   * Set when Stop reached the run after it had already recorded its own
   * outcome. The owed turn then starts only to stop at once with this
   * origin, so the person sees one stopped turn and nothing runs.
   */
  stopOrigin?: Origin;
}

export interface ChatOwedTurnsDeps<Context, Origin extends string> {
  /** True while main can no longer run a turn in this chat (it is being deleted, or the app is quitting). */
  refuses(chatId: string): boolean;
  /** Starts the owed turn. Called at most once per run, never retried. */
  start(plan: OwedTurnPlan<Context, Origin>): void;
  /** A `start` that threw; the saved input stays in the chat as history. */
  onStartError?(error: unknown, plan: OwedTurnPlan<Context, Origin>): void;
}

export interface RunSettlement {
  /** Saved input Pi still held when the run ended, in queue order. */
  committed: readonly OwedChatInput[];
  /** The run already recorded a Stop, so the input it owed stays history. */
  recordedStop: boolean;
}

interface Entry<Context, Origin extends string> {
  chatId: string;
  ownerDocumentId: string;
  context: Context;
  holds: number;
  registered: OwedChatInput[];
  committed: OwedChatInput[];
  stop?: Origin;
  settled?: { recordedStop: boolean };
}

/**
 * Owed turns for runs that end with saved input they never answered.
 *
 * Pi closes a run's queues at `agent_end`, but the host may still be saving
 * input admission accepted a moment earlier, and a run can end on a turn
 * that never polls its queues. Either way the input is already in the chat,
 * so the chat owes it a turn. Admission takes a hold before it saves input
 * and registers the input here when the run's queue no longer takes it; the
 * run reports the saved input Pi never read when it settles. Once the run has
 * settled and every hold is released, the owed turn starts exactly once.
 *
 * Nothing starts when the run recorded a Stop, when the chat is being
 * deleted, or when the app is quitting: the input stays as history. A Stop
 * that reached the run after it recorded its outcome stops the owed turn at
 * once instead, so the person sees exactly one stopped turn.
 */
export function createChatOwedTurns<Context, Origin extends string>(
  deps: ChatOwedTurnsDeps<Context, Origin>,
) {
  const entries = new Map<string, Entry<Context, Origin>>();
  let shuttingDown = false;

  const closed = (entry: Entry<Context, Origin>) =>
    shuttingDown || entry.stop !== undefined || deps.refuses(entry.chatId);

  function finalize(streamId: string, entry: Entry<Context, Origin>): void {
    if (!entry.settled || entry.holds > 0 || entries.get(streamId) !== entry) return;
    entries.delete(streamId);
    if (shuttingDown || entry.settled.recordedStop || deps.refuses(entry.chatId)) return;
    const seen = new Set<string>();
    const inputs = [...entry.committed, ...entry.registered].filter((input) => {
      if (seen.has(input.messageId)) return false;
      seen.add(input.messageId);
      return true;
    });
    if (inputs.length === 0) return;
    const plan: OwedTurnPlan<Context, Origin> = {
      chatId: entry.chatId,
      settledStreamId: streamId,
      context: entry.context,
      inputs,
      ...(entry.stop !== undefined ? { stopOrigin: entry.stop } : {}),
    };
    try {
      deps.start(plan);
    } catch (error) {
      deps.onStartError?.(error, plan);
    }
  }

  return {
    /** A run that can owe its chat a turn has started. */
    open(streamId: string, run: { chatId: string; ownerDocumentId: string; context: Context }): void {
      if (shuttingDown || entries.has(streamId)) return;
      entries.set(streamId, {
        chatId: run.chatId,
        ownerDocumentId: run.ownerDocumentId,
        context: run.context,
        holds: 0,
        registered: [],
        committed: [],
      });
    },

    /**
     * Holds the run's owed turn open while admission saves one input.
     * Undefined once the run's owed turn can no longer take input.
     */
    hold(streamId: string): ChatOwedInputHold | undefined {
      const entry = entries.get(streamId);
      if (!entry || closed(entry)) return undefined;
      entry.holds += 1;
      let open = true;
      return {
        register: (input) => {
          if (!open || entries.get(streamId) !== entry || closed(entry)) return false;
          entry.registered.push({ ...input });
          return true;
        },
        release: () => {
          if (!open) return;
          open = false;
          entry.holds -= 1;
          finalize(streamId, entry);
        },
      };
    },

    /**
     * Stop reached this run, which may already have settled while input is
     * still being saved. The first origin wins. True when this marked a run
     * whose owed turn has not started yet; a named owner must be the run's.
     */
    stop(streamId: string, origin: Origin, ownerDocumentId?: string): boolean {
      const entry = entries.get(streamId);
      if (!entry || entry.stop !== undefined) return false;
      if (ownerDocumentId !== undefined && entry.ownerDocumentId !== ownerDocumentId) return false;
      entry.stop = origin;
      return true;
    },

    /** Stop reached every run of the chat. */
    stopChat(chatId: string, origin: Origin): void {
      for (const entry of entries.values()) {
        if (entry.chatId === chatId && entry.stop === undefined) entry.stop = origin;
      }
    },

    /** The app is quitting: no owed turn starts again in this process. */
    shutDown(): void {
      shuttingDown = true;
      entries.clear();
    },

    /** A settled run is still waiting for input that is being saved. */
    isHolding(chatId: string): boolean {
      for (const entry of entries.values()) {
        if (entry.chatId === chatId && entry.settled && entry.holds > 0) return true;
      }
      return false;
    },

    /** The run has settled; its owed turn starts once no input is being saved. Idempotent. */
    settle(streamId: string, settlement: RunSettlement): void {
      const entry = entries.get(streamId);
      if (!entry || entry.settled) return;
      entry.settled = { recordedStop: settlement.recordedStop };
      entry.committed = settlement.committed.map((input) => ({ ...input }));
      finalize(streamId, entry);
    },
  };
}

export type ChatOwedTurns<Context, Origin extends string> = ReturnType<
  typeof createChatOwedTurns<Context, Origin>
>;
