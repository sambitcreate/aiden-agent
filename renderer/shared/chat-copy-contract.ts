export const MAX_VISIBLE_COPY_MESSAGES = 10_000;
export const MAX_VISIBLE_FORK_CHOICES = 100;
export const MAX_FORK_PREVIEW_CODE_UNITS = 256;
export const MAX_FORK_QUERY_CODE_UNITS = 256;
export const MAX_CHAT_TITLE_CHARS = 120;
export const MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS = 1_000;
export const MAX_FORK_SUMMARY_TEXT_CHARS = 32_000;
export const MAX_FORK_SUMMARY_FILES = 200;
const MAX_FORK_SUMMARY_PATH_CHARS = 1_024;

/**
 * Where a fork cuts the source transcript. `after` keeps the chosen settled
 * assistant reply; `before` keeps everything strictly before the chosen user
 * message so its text can be edited and resent in the fork.
 */
export type ChatForkPosition = "after" | "before";

export type ChatForkSummaryState = "pending" | "ready" | "failed";

/**
 * "Fork with summary": what happened in the source chat after the cut,
 * summarized for the fork. While it is pending or failed the fork does not
 * generate, so the summary always lands right after the copied history.
 */
export interface ChatForkSummaryV1 {
  state: ChatForkSummaryState;
  /** The fork's last copied message; the summary follows it in model context. */
  afterMessageId: string;
  /** Optional "Focus the summary on…" text, kept so Retry asks the same thing. */
  instructions?: string;
  /** Present once ready. The chat index keeps only the state. */
  text?: string;
  files?: { read: string[]; modified: string[] };
  /** Why the last attempt failed, when it did. */
  error?: string;
}

/** Main-owned provenance recorded on a chat created by Fork. */
export interface ChatForkLineageV1 {
  chatId: string;
  messageId: string;
  position: ChatForkPosition;
  /** Epoch milliseconds when the fork was created. */
  at: number;
  summary?: ChatForkSummaryV1;
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

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function summaryPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FORK_SUMMARY_FILES) return undefined;
  const paths = value.map((item) => boundedText(item, MAX_FORK_SUMMARY_PATH_CHARS));
  return paths.every((item) => item !== undefined) ? (paths as string[]) : undefined;
}

const SUMMARY_KEYS = new Set(["state", "afterMessageId", "instructions", "text", "files", "error"]);

/** Strict, exact-shape parser for a fork summary. */
export function parseChatForkSummaryV1(value: unknown): ChatForkSummaryV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SUMMARY_KEYS.has(key))) return undefined;
  const { state } = record;
  if (state !== "pending" && state !== "ready" && state !== "failed") return undefined;
  const afterMessageId = lineageId(record.afterMessageId);
  if (!afterMessageId) return undefined;
  const summary: ChatForkSummaryV1 = { state, afterMessageId };
  for (const [key, maximum] of [
    ["instructions", MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS],
    ["text", MAX_FORK_SUMMARY_TEXT_CHARS],
    ["error", MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS],
  ] as const) {
    if (record[key] === undefined) continue;
    const text = boundedText(record[key], maximum);
    if (text === undefined) return undefined;
    summary[key] = text;
  }
  if (record.files !== undefined) {
    const files = record.files as Record<string, unknown> | null;
    if (!files || typeof files !== "object" || Array.isArray(files)) return undefined;
    if (Object.keys(files).length !== 2) return undefined;
    const read = summaryPaths(files.read);
    const modified = summaryPaths(files.modified);
    if (!read || !modified) return undefined;
    summary.files = { read, modified };
  }
  return summary;
}

/**
 * Strict, exact-shape parser. Anything else is dropped, never repaired. A
 * damaged summary is dropped on its own: the fork stays a plain fork.
 */
export function parseChatForkLineageV1(value: unknown): ChatForkLineageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => key !== "summary");
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
  const summary = parseChatForkSummaryV1(record.summary);
  return {
    chatId,
    messageId,
    position: record.position,
    at: record.at,
    ...(summary ? { summary } : {}),
  };
}

/** True while a fork must not generate: its summary is not settled yet. */
/** Why a fork refuses a new message while its summary is unsettled. */
export const FORK_SUMMARY_HOLD_MESSAGE =
  "This fork is waiting for its summary. Wait for it, retry it, or continue without it.";

export function forkSummaryHoldsSend(lineage: ChatForkLineageV1 | undefined): boolean {
  const state = lineage?.summary?.state;
  return state === "pending" || state === "failed";
}

/** `chats:fork-summary-changed`: a fork's summary state changed in main. */
export interface ChatForkSummaryChanged {
  chatId: string;
  forkedFrom?: ChatForkLineageV1;
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
