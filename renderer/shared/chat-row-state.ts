/**
 * Chat list row state shared by the desktop sidebar and the Aiden Remote chat
 * summary projection. The order is the display priority: a chat that is
 * blocked on the user outranks one that is merely working.
 */
export const CHAT_ROW_STATES = ["needs_approval", "needs_input", "working", "idle"] as const;
export type ChatRowState = (typeof CHAT_ROW_STATES)[number];

export interface ChatRowStateSignals {
  /** A generation for this chat is running (or reconciling). */
  active: boolean;
  /** A tool approval prompt for this chat is waiting on the user. */
  needsApproval: boolean;
  /** An ask-user question prompt for this chat is waiting on the user. */
  needsInput: boolean;
}

/**
 * Collapse the independent signals into one row state. Attention prompts only
 * exist while a generation is parked on them, but a prompt is still reported
 * even if the activity signal lags behind, because hiding a blocking prompt is
 * the worse failure.
 */
export function chatRowState(signals: Readonly<ChatRowStateSignals>): ChatRowState {
  if (signals.needsApproval) return "needs_approval";
  if (signals.needsInput) return "needs_input";
  if (signals.active) return "working";
  return "idle";
}

export function isChatRowState(value: unknown): value is ChatRowState {
  return typeof value === "string" && (CHAT_ROW_STATES as readonly string[]).includes(value);
}

export const CHAT_ROW_STATE_LABELS: Readonly<Record<ChatRowState, string>> = {
  needs_approval: "Needs approval",
  needs_input: "Needs input",
  working: "Working",
  idle: "Idle",
};

/**
 * Durable "last viewed" markers. `baselineAt` is the moment read tracking was
 * first enabled on this installation: assistant output older than it is never
 * reported as unread, so upgrading does not light up every historic chat.
 */
export interface ChatReadMarkersSnapshot {
  revision: number;
  baselineAt: number;
  /** Chat id -> createdAt (epoch ms) of the newest message the user viewed. */
  readThrough: Record<string, number>;
}

const SAFE_CHAT_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
export const MAX_CHAT_READ_MARKERS = 10_000;

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseChatReadMarkersSnapshot(value: unknown): ChatReadMarkersSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isTimestamp(record.revision) || !isTimestamp(record.baselineAt)) return null;
  const raw = record.readThrough;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const readThrough: Record<string, number> = {};
  let count = 0;
  for (const [chatId, at] of Object.entries(raw as Record<string, unknown>)) {
    if (!SAFE_CHAT_ID.test(chatId) || !isTimestamp(at)) return null;
    if (++count > MAX_CHAT_READ_MARKERS) return null;
    readThrough[chatId] = at;
  }
  return { revision: record.revision, baselineAt: record.baselineAt, readThrough };
}

/**
 * Honest unread: only when assistant output was persisted after the user last
 * viewed the chat. A chat with no recorded assistant output time (legacy index
 * rows, chats with no reply yet) is never unread.
 */
export function isChatUnread(
  lastAssistantAt: number | undefined,
  markers: Pick<ChatReadMarkersSnapshot, "baselineAt" | "readThrough"> | null | undefined,
  chatId: string,
): boolean {
  if (!markers || !isTimestamp(lastAssistantAt)) return false;
  const viewed = Math.max(markers.baselineAt, markers.readThrough[chatId] ?? 0);
  return lastAssistantAt > viewed;
}
