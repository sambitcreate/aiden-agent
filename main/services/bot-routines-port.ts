/**
 * Ports Bot routines use to reach a Bot's conversation.
 *
 * `BotRoutineSessionPort` is exactly the `send`/`state` subset of the planned
 * `BotSessionService` (Bots rework plan, Task 1.3). Until that service lands,
 * `scheduled-bot-routines-main.ts` wires these ports to a temporary adapter
 * over the existing Bot chat send path (`bot-routines-legacy-session.ts`).
 *
 * `BotRoutineReplyPort` is the small addition routines need on top of that
 * subset: waiting for a routine submission's final reply, and marking a
 * `[SILENT]` reply as audit-only (stored, but no bubble, preview or unread).
 */

/** Exact copy of `BotSessionState` from the Bots rework plan, Task 1.3. */
export type BotSessionState =
  | { kind: "idle" }
  | { kind: "running"; submissionId: string }
  | { kind: "interrupted"; submissionId: string }
  | { kind: "needs_model" }
  | { kind: "unavailable"; reason: "held_by_live_process" };

export interface BotRoutineSessionPort {
  send(
    botId: string,
    input: { text: string; requestId: string },
  ): Promise<{ submissionId: string; deduped: boolean }>;
  state(botId: string): Promise<BotSessionState>;
}

export type BotRoutineSubmissionOutcome =
  | { kind: "completed"; text: string }
  | { kind: "failed"; error: string }
  | { kind: "interrupted" };

export interface BotRoutineReplyPort {
  /** Resolves once the submission settles. Aborting the signal stops waiting only. */
  awaitReply(
    botId: string,
    submissionId: string,
    signal: AbortSignal,
  ): Promise<BotRoutineSubmissionOutcome>;
  /** Keeps the reply for audit but hides it from the transcript, preview and unread state. */
  markSilent(botId: string, submissionId: string): Promise<void>;
}

export type BotRoutinePorts = BotRoutineSessionPort & BotRoutineReplyPort;
