export const MAX_VISIBLE_COPY_MESSAGES = 10_000;
export const MAX_VISIBLE_FORK_CHOICES = 100;
export const MAX_FORK_PREVIEW_CODE_UNITS = 256;
export const MAX_FORK_QUERY_CODE_UNITS = 256;
export const MAX_CHAT_TITLE_CHARS = 120;

/**
 * Where a fork cuts the source transcript. `after` keeps the chosen settled
 * assistant reply; `before` keeps everything strictly before the chosen user
 * message so its text can be edited and resent in the fork.
 */
export type ChatForkPosition = "after" | "before";

/** Main-owned provenance recorded on a chat created by Fork. */
export interface ChatForkLineageV1 {
  chatId: string;
  messageId: string;
  position: ChatForkPosition;
  /** Epoch milliseconds when the fork was created. */
  at: number;
}

const MAX_LINEAGE_ID_CHARS = 160;
const SAFE_LINEAGE_ID = /^[A-Za-z0-9_-]+$/u;

function lineageId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LINEAGE_ID_CHARS &&
    SAFE_LINEAGE_ID.test(value)
    ? value
    : undefined;
}

/** Strict, exact-shape parser. Anything else is dropped, never repaired. */
export function parseChatForkLineageV1(value: unknown): ChatForkLineageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || !["chatId", "messageId", "position", "at"].every((key) => keys.includes(key))) {
    return undefined;
  }
  const chatId = lineageId(record.chatId);
  const messageId = lineageId(record.messageId);
  if (!chatId || !messageId) return undefined;
  if (record.position !== "after" && record.position !== "before") return undefined;
  if (typeof record.at !== "number" || !Number.isSafeInteger(record.at) || record.at < 0) {
    return undefined;
  }
  return { chatId, messageId, position: record.position, at: record.at };
}

const FORK_SUFFIX = / \(fork(?: (\d{1,6}))?\)$/u;

/** The title a fork suffix was appended to, so forks of forks don't stack suffixes. */
export function forkTitleBase(title: string): string {
  const base = title.replace(FORK_SUFFIX, "").trim();
  return base || title.trim() || "Chat";
}

/**
 * `Title (fork)`, then `Title (fork 2)`, `Title (fork 3)` … numbered past the
 * highest existing fork of the same base title.
 */
export function nextForkTitle(sourceTitle: string, existingTitles: Iterable<string>): string {
  const base = forkTitleBase(sourceTitle);
  let highest = 0;
  for (const title of existingTitles) {
    const match = FORK_SUFFIX.exec(title);
    if (!match) continue;
    const siblingBase = forkTitleBase(title);
    // A long base was cut to fit its suffix, so a full-length sibling still
    // counts when its base is a prefix of ours.
    const truncated = Array.from(title).length >= MAX_CHAT_TITLE_CHARS && base.startsWith(siblingBase);
    if (siblingBase !== base && !truncated) continue;
    highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  const suffix = highest === 0 ? " (fork)" : ` (fork ${highest + 1})`;
  const maximumBaseLength = Math.max(1, MAX_CHAT_TITLE_CHARS - suffix.length);
  return `${Array.from(base.slice(0, maximumBaseLength * 2)).slice(0, maximumBaseLength).join("")}${suffix}`;
}
