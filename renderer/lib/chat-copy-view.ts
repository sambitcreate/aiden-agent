import type { ChatMessage } from "./types.js";
import {
  MAX_FORK_PREVIEW_CODE_UNITS,
  MAX_FORK_QUERY_CODE_UNITS,
  MAX_VISIBLE_COPY_MESSAGES,
  MAX_VISIBLE_FORK_CHOICES,
} from "../shared/chat-copy-contract.js";
import { boundedUnicodePrefix } from "../shared/unicode-prefix.js";

export interface ForkTurnChoice {
  /** The settled assistant reply a plain fork keeps. */
  id: string;
  /**
   * The prompt that opened this turn; Edit in fork cuts just before it.
   * Absent when the chat can't fork before a prompt (Bot chats).
   */
  userMessageId?: string;
  label: string;
  createdAt: number;
  turnNumber: number;
}

export function forkTurnEligibility(
  messages: readonly ChatMessage[],
  options: { editInFork?: boolean } = {},
): {
  turns: ForkTurnChoice[];
  cloneBlocked: boolean;
} {
  const turns: ForkTurnChoice[] = [];
  let latestUserLabel: string | undefined;
  let latestUserId: string | undefined;
  let visibleMessageCount = 0;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    visibleMessageCount += 1;
    if (visibleMessageCount > MAX_VISIBLE_COPY_MESSAGES) {
      return { turns, cloneBlocked: true };
    }
    if (message.role === "user") {
      const preview = boundedUnicodePrefix(message.content, MAX_FORK_PREVIEW_CODE_UNITS)
        .replace(/\s+/gu, " ")
        .trim();
      latestUserLabel = preview
        ? Array.from(preview).slice(0, 96).join("")
        : "Attachment-only turn";
      latestUserId = message.id;
    } else if (latestUserLabel && latestUserId) {
      turns.push({
        id: message.id,
        ...(options.editInFork === false ? {} : { userMessageId: latestUserId }),
        label: latestUserLabel,
        createdAt: message.createdAt,
        turnNumber: turns.length + 1,
      });
    }
  }
  return { turns, cloneBlocked: false };
}

export function filterForkTurnChoices(
  turns: readonly ForkTurnChoice[],
  rawQuery: string,
): ForkTurnChoice[] {
  if (rawQuery.length > MAX_FORK_QUERY_CODE_UNITS) return [];
  const query = rawQuery.trim().toLocaleLowerCase();
  const exactTurn = turns.find((turn) => String(turn.turnNumber) === query);
  if (exactTurn) return [exactTurn];
  const matches = query
    ? turns.filter(
        (turn) =>
          turn.label.toLocaleLowerCase().includes(query),
      )
    : turns;
  return matches.slice(Math.max(0, matches.length - MAX_VISIBLE_FORK_CHOICES));
}

/** Plain-language provenance for a forked chat; the source may have been deleted. */
export function forkedFromLabel(sourceTitle: string | undefined): string {
  const title = sourceTitle?.trim();
  return title ? `Forked from “${title}”` : "Forked from a deleted chat";
}
