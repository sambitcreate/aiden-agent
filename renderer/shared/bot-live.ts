// The renderer's view of a Bot's one durable conversation (plan Task 1.4).
//
// Main projects the Pi Durable transcript into these entries and streams them
// over `bots:live:event`; `bots:live:subscribe` returns a full snapshot. Every
// event carries `(epoch, seq)`: `epoch` changes whenever the Bot's session is
// reopened, and `seq` increases by one per event within an epoch. A client
// that sees a different epoch or a gap re-subscribes for a fresh snapshot.

import type { BotSessionState } from "../../main/services/bot-runtime/bot-session-service.js";
import type { ConnectCardEntry } from "./bot-connections.js";
import type { AskUserQuestionV1 } from "./ask-user-question.js";

export type { BotSessionState };

/** The exact reply a routine gives when it has nothing new; kept, never shown. */
export const BOT_SILENT_REPLY = "[SILENT]";

/** A question the Bot is waiting on: the A–E quick-reply card. One per Bot at a time. */
export interface BotPendingQuestion {
  botId: string;
  /** The durable wait id; the answer is posted against it. */
  waitId: string;
  toolCallId: string;
  questions: AskUserQuestionV1[];
}

/**
 * `details` of an answered Bot `ask_user_question` tool result: what the person
 * chose, as shown in the transcript (`summarizeAskUserQuestionResponse`).
 */
export interface BotQuestionAnswerDetails {
  answerText: string;
}

/** The person-facing answer text of a question tool result, or undefined. */
export function botQuestionAnswerText(details: unknown): string | undefined {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const text = (details as { answerText?: unknown }).answerText;
  return typeof text === "string" && text.trim().length > 0 ? text : undefined;
}

export interface BotTranscriptToolCall {
  id: string;
  name: string;
}

export type BotTranscriptEntry =
  | {
      id: string;
      type: "user";
      text: string;
      imageCount: number;
      at?: number;
    }
  /** The input of a routine run, shown as a label instead of a bubble. */
  | {
      id: string;
      type: "routine";
      label: string;
      text: string;
      at?: number;
    }
  | {
      id: string;
      type: "assistant";
      text: string;
      toolCalls: BotTranscriptToolCall[];
      stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "other";
      errorMessage?: string;
      at?: number;
    }
  | {
      id: string;
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      isError: boolean;
    }
  | {
      id: string;
      type: "notice";
      notice: "interrupted" | "session_reset";
    }
  | {
      id: string;
      type: "connect_card";
      card: ConnectCardEntry;
    }
  /** The person's answer to an A–E question, shown where the question was. */
  | {
      id: string;
      type: "question_answer";
      text: string;
      at?: number;
    }
  /**
   * A file the Bot wrote or edited in its folder (host-confirmed by the tool
   * result, never inferred from text). Shown as a chip that opens Files.
   */
  | {
      id: string;
      type: "file";
      /** Path inside the Bot's folder, `/`-separated. */
      path: string;
      operation: "written" | "edited";
      at?: number;
    }
  /** An image the Bot shared (`share_image`), shown as an image chip. */
  | {
      id: string;
      type: "shared_image";
      name: string;
      mimeType: string;
      size: number;
      /** Base64 bytes. */
      data: string;
    }
  /**
   * A reply that failed after the retry policy gave up (spec §10). Shown as
   * "I couldn't finish that reply." with Retry, which sends `retryText` again
   * as a new message with a new request id. `retryText` is null when the turn
   * had no typed message to resend (a routine, the self-intro, photos only).
   */
  | {
      id: string;
      type: "failed_turn";
      retryText: string | null;
      /** The model's error, for the Mac only; never sent to phones. */
      errorMessage?: string;
      at?: number;
    };

/** What a failed turn says, on every client. */
export const BOT_FAILED_TURN_TEXT = "I couldn't finish that reply.";

/** Id of the failed-turn entry that follows a failed assistant entry. */
export function botFailedTurnId(assistantEntryId: string): string {
  return `${assistantEntryId}:failed`;
}

/**
 * The failed turn that Retry applies to: the newest entry, when it is a failed
 * turn with a message to resend. Older failures are history, not actions.
 */
export function botRetryableFailedTurn(
  entries: readonly BotTranscriptEntry[],
): Extract<BotTranscriptEntry, { type: "failed_turn" }> | null {
  const last = entries[entries.length - 1];
  return last?.type === "failed_turn" && last.retryText !== null ? last : null;
}

export interface BotLiveSnapshot {
  botId: string;
  epoch: string;
  seq: number;
  entries: BotTranscriptEntry[];
  /** Text of the reply being written right now, or null. */
  partial: string | null;
  state: BotSessionState;
  /** The question the Bot is waiting on, or null. */
  question: BotPendingQuestion | null;
}

export type BotLiveEventBody =
  | { type: "entry"; entry: BotTranscriptEntry }
  | { type: "partial"; text: string | null }
  | { type: "state"; state: BotSessionState }
  | { type: "question"; question: BotPendingQuestion | null }
  /** Replaces everything: after an overflow, a reopen, or a retroactive change. */
  | { type: "snapshot"; snapshot: BotLiveSnapshot };

export type BotLiveEvent = { botId: string; epoch: string; seq: number } & BotLiveEventBody;

/** What a Bot list row shows, read from the same projection. */
export interface BotLiveSummary {
  botId: string;
  preview: string | null;
  updatedAt: number | null;
  state: BotSessionState;
}

/** The last thing worth previewing in a list row: the newest visible message text. */
export function botTranscriptPreview(entries: readonly BotTranscriptEntry[]): { text: string; at?: number } | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "assistant" && entry.text.trim()) {
      return { text: oneLine(entry.text), ...(entry.at === undefined ? {} : { at: entry.at }) };
    }
    if (entry.type === "user" && (entry.text.trim() || entry.imageCount > 0)) {
      const text = entry.text.trim() ? oneLine(entry.text) : entry.imageCount === 1 ? "Photo" : `${entry.imageCount} photos`;
      return { text, ...(entry.at === undefined ? {} : { at: entry.at }) };
    }
    if (entry.type === "question_answer") {
      return { text: oneLine(entry.text), ...(entry.at === undefined ? {} : { at: entry.at }) };
    }
    if (entry.type === "routine") {
      return { text: entry.label, ...(entry.at === undefined ? {} : { at: entry.at }) };
    }
  }
  return null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Apply one event to a snapshot. Returns null when the event cannot be applied
 * (another epoch, or a gap in `seq`): the caller re-subscribes.
 */
export function applyBotLiveEvent(snapshot: BotLiveSnapshot, event: BotLiveEvent): BotLiveSnapshot | null {
  if (event.botId !== snapshot.botId) return snapshot;
  if (event.type === "snapshot") return event.snapshot;
  if (event.epoch !== snapshot.epoch) return null;
  if (event.seq <= snapshot.seq) return snapshot;
  if (event.seq !== snapshot.seq + 1) return null;
  switch (event.type) {
    case "entry":
      return {
        ...snapshot,
        seq: event.seq,
        entries: [...snapshot.entries.filter((entry) => entry.id !== event.entry.id), event.entry],
      };
    case "partial":
      return { ...snapshot, seq: event.seq, partial: event.text };
    case "state":
      return { ...snapshot, seq: event.seq, state: event.state };
    case "question":
      return { ...snapshot, seq: event.seq, question: event.question };
  }
}
