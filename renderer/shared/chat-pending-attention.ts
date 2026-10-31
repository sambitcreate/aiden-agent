/**
 * What a local chat is waiting on, as `chats:pendingAttention` reports it for
 * the Inbox. Times are the main process's epoch milliseconds.
 *
 * - `approval` / `question`: a live prompt, answerable in the chat.
 * - `detached`: a prompt settled because its window left the chat ("Unavailable").
 * - `interrupted`: a prompt saved when a quit or crash cut the reply short.
 * - `working`: a live run with nothing to answer; only `runStartedAt` matters.
 */
export const CHAT_PENDING_ATTENTION_KINDS = ["approval", "question", "detached", "interrupted", "working"] as const;
export type ChatPendingAttentionKind = (typeof CHAT_PENDING_ATTENTION_KINDS)[number];

export interface ChatPendingAttention {
  chatId: string;
  kind: ChatPendingAttentionKind;
  /** The oldest waiting prompt's command or question, at most 200 characters. Empty for `working`. */
  summary: string;
  /** When the oldest waiting prompt was raised. Absent for `working`. */
  since?: number;
  /** When the run the prompt belongs to started. */
  runStartedAt?: number;
  /** Prompts of this kind waiting; 0 for `working`. */
  count: number;
}

export const CHAT_PENDING_ATTENTION_SUMMARY_MAX = 200;
/** Ids per request: a host lists at most 2,000 chats. */
export const CHAT_PENDING_ATTENTION_MAX_IDS = 2_000;

/**
 * One line, at most 200 characters, ending in an ellipsis when cut. Line
 * breaks become spaces; other control and invisible formatting characters
 * (bidi overrides, zero-width spaces) are dropped so a tooltip shows the text
 * as it reads.
 */
export function clipPendingAttentionSummary(text: unknown): string {
  if (typeof text !== "string") return "";
  const oneLine = text
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  const characters = Array.from(oneLine);
  return characters.length <= CHAT_PENDING_ATTENTION_SUMMARY_MAX
    ? characters.join("")
    : `${characters.slice(0, CHAT_PENDING_ATTENTION_SUMMARY_MAX - 1).join("")}…`;
}
