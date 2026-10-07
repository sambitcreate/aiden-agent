// The renderer's view of a Bot's one durable conversation (plan Task 1.4).
//
// Main projects the Pi Durable transcript into these entries and streams them
// over `bots:live:event`; `bots:live:subscribe` returns a full snapshot. Every
// event carries `(epoch, seq)`: `epoch` changes whenever the Bot's session is
// reopened, and `seq` increases by one per event within an epoch. A client
// that sees a different epoch or a gap re-subscribes for a fresh snapshot.

import type { BotSessionState } from "../../main/services/bot-runtime/bot-session-service.js";
import type { ConnectCardEntry } from "./bot-connections.js";

export type { BotSessionState };

/** The exact reply a routine gives when it has nothing new; kept, never shown. */
export const BOT_SILENT_REPLY = "[SILENT]";

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
    };

export interface BotLiveSnapshot {
  botId: string;
  epoch: string;
  seq: number;
  entries: BotTranscriptEntry[];
  /** Text of the reply being written right now, or null. */
  partial: string | null;
  state: BotSessionState;
}

export type BotLiveEventBody =
  | { type: "entry"; entry: BotTranscriptEntry }
  | { type: "partial"; text: string | null }
  | { type: "state"; state: BotSessionState }
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
  }
}
