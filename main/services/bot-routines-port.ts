/**
 * Ports Bot routines use to reach a Bot's conversation: the subset of the
 * durable `BotSessionService` (`bot-runtime/bot-session-service.ts`) that
 * routines need. `scheduled-bot-routines-main.ts` wires them to that service.
 *
 * `BotRoutineReplyPort` waits for a routine submission's final reply and marks
 * a `[SILENT]` reply as audit-only (stored, but no bubble, preview or unread).
 */

import type { BotReplyOutcome, BotSessionState } from "./bot-runtime/bot-session-service.js";
import type { BotRoutineInputOrigin } from "./bot-runtime/bot-input-entry.js";

export type { BotSessionState };

/** Host facts captured when this occurrence was claimed, never client input. */
export interface BotRoutineTiming { scheduledFor?: number; timezone?: string }

export function parseBotRoutineTiming(value: unknown): BotRoutineTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routine occurrence.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "scheduledFor" && key !== "timezone") ||
    input.scheduledFor !== undefined && (!Number.isSafeInteger(input.scheduledFor) || (input.scheduledFor as number) < 0) ||
    input.timezone !== undefined && (typeof input.timezone !== "string" || !input.timezone.trim() || input.timezone.length > 100) ||
    input.scheduledFor !== undefined && input.timezone === undefined) throw new Error("Invalid routine occurrence.");
  if (input.timezone !== undefined) new Intl.DateTimeFormat("en", { timeZone: input.timezone as string });
  return { ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor as number }), ...(input.timezone === undefined ? {} : { timezone: input.timezone as string }) };
}

export interface BotRoutineSessionPort {
  /** Read-only Pi admission lookup; never starts or resumes the Bot. */
  submissionForRequest(botId: string, requestId: string): Promise<string | undefined>;
  send(
    botId: string,
    input: {
      text: string;
      requestId: string;
      /** Refuse with `bot_paused` instead of dismissing an interrupted turn. */
      ifNotInterrupted?: boolean;
      /** The routine name, shown on the turn. */
      label?: string;
      /** Internal executor facts; production validates and issues these before send. */
      routineOrigin?: BotRoutineInputOrigin;
      routineTiming?: BotRoutineTiming;
      /** Original accepted fire, only for a verified host retry. */
      retryOf?: string;
    },
  ): Promise<{ submissionId: string; deduped: boolean }>;
  state(botId: string): Promise<BotSessionState>;
}

export type BotRoutineSubmissionOutcome = BotReplyOutcome;

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
