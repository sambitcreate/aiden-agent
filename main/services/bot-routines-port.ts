/**
 * Ports Bot routines use to reach a Bot's conversation: the subset of the
 * durable `BotSessionService` (`bot-runtime/bot-session-service.ts`) that
 * routines need. `scheduled-bot-routines-main.ts` wires them to that service.
 *
 * `BotRoutineReplyPort` waits for a routine submission's final reply and marks
 * a `[SILENT]` reply as audit-only (stored, but no bubble, preview or unread).
 */

import type { BotSessionState } from "./bot-runtime/bot-session-service.js";

export type { BotSessionState };

export interface BotRoutineSessionPort {
  send(
    botId: string,
    input: {
      text: string;
      requestId: string;
      /** Refuse with `bot_paused` instead of dismissing an interrupted turn. */
      ifNotInterrupted?: boolean;
      /** The routine name, shown on the turn. */
      label?: string;
    },
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
