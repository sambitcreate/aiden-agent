// Aiden Live's chat tools: the names, bounds and the pure rules both main
// (argument checks) and the window (running the tools) share. Nothing here
// touches the DOM, IPC or approvals.

import { redactBareCredentialTokens } from "./credential-tokens";

export const LIVE_CHAT_TOOL_NAMES = [
  "read_open_chat",
  "send_to_open_chat",
  "stop_open_chat",
  "find_and_open_chat",
  "start_new_chat",
] as const;
export type LiveChatToolName = (typeof LIVE_CHAT_TOOL_NAMES)[number];

export const LIVE_CHAT_SEND_MODES = ["auto", "steer", "queue"] as const;
export type LiveChatSendMode = (typeof LIVE_CHAT_SEND_MODES)[number];

/** Most messages read_open_chat returns, and its default. */
export const LIVE_CHAT_MAX_READ_MESSAGES = 20;
export const LIVE_CHAT_DEFAULT_READ_MESSAGES = 10;
/** Total characters of message text read_open_chat returns; the newest are kept. */
export const LIVE_CHAT_MAX_READ_CHARS = 12_000;
/** Longest message Live may send for the person. */
export const LIVE_CHAT_MAX_SEND_CHARS = 4_000;
export const LIVE_CHAT_MAX_QUERY_CHARS = 200;
export const LIVE_CHAT_MAX_WORKSPACE_CHARS = 200;
/** Longest spoken update note about a chat. */
export const LIVE_CHAT_MAX_NOTE_CHARS = 300;
/** How many close titles find_and_open_chat offers when it can't pick one. */
export const LIVE_CHAT_MAX_CANDIDATES = 3;

/** Fixed failures the window returns; Live reads `message` aloud in its own words. */
export const LIVE_CHAT_ERRORS = {
  noChat: { code: "no_open_chat", message: "No chat is open in Aiden's main window." },
  off: { code: "chat_access_off", message: "Chat access for Live is off in Settings." },
  notReady: { code: "chat_not_ready", message: "This chat isn't ready to send. Check its model in Aiden." },
  firstSending: { code: "chat_busy", message: "The chat's first message is still sending." },
  nothingRunning: { code: "nothing_running", message: "Nothing is running in this chat." },
  cannotStop: { code: "cannot_stop", message: "This reply can't be stopped yet. Try again in a moment." },
  cannotSteer: {
    code: "cannot_steer",
    message: "This reply can't take guidance right now. Queue the message instead.",
  },
  nothingToSteer: {
    code: "nothing_to_steer",
    message: "Nothing is running in this chat, so there is nothing to steer. Send it instead.",
  },
  cannotQueue: { code: "cannot_queue", message: "This chat can't queue a message right now." },
  sendFailed: { code: "send_failed", message: "Aiden couldn't send the message." },
  notFound: { code: "chat_not_found", message: "No chat has a title like that." },
  navigationBlocked: { code: "navigation_blocked", message: "Aiden can't leave the open chat right now." },
  workspaceNotFound: { code: "workspace_not_found", message: "No workspace has a name like that." },
  newChatFailed: { code: "new_chat_failed", message: "Aiden couldn't start a new chat." },
  invalid: { code: "invalid_arguments", message: "The request was not valid." },
} as const;

export type LiveChatError = (typeof LIVE_CHAT_ERRORS)[keyof typeof LIVE_CHAT_ERRORS];

export function liveChatFailure(error: LiveChatError): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: error.code, message: error.message } };
}

// ---------------------------------------------------------------------------
// read_open_chat

/** The transcript shape the rule below reads; a subset of ChatMessage. */
export interface LiveChatTranscriptMessage {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: readonly unknown[];
  notice?: { title: string; summary: string };
  inputSource?: "voice";
  timeline?: { steps: ReadonlyArray<{ kind: string; toolName?: string }> };
  providerFailure?: unknown;
}

export interface LiveChatReadMessage {
  role: "user" | "assistant";
  text: string;
  /** Live sent this message for the person. */
  byVoice?: true;
}

const REDACTED = "[hidden]";

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function toolSummary(steps: ReadonlyArray<{ kind: string; toolName?: string }> | undefined): string | null {
  if (!steps?.length) return null;
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== "tool" || typeof step.toolName !== "string") continue;
    const name = step.toolName.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 40);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts].slice(0, 8).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const more = counts.size > 8 ? `, and ${counts.size - 8} more` : "";
  return `[Used tools: ${parts.join(", ")}${more}]`;
}

function messageText(message: LiveChatTranscriptMessage): string {
  if (message.role === "user" && message.notice) {
    return oneLine(`[Notice] ${message.notice.title}: ${message.notice.summary}`);
  }
  const parts: string[] = [];
  if (message.role === "assistant") {
    const tools = toolSummary(message.timeline?.steps);
    if (tools) parts.push(tools);
  }
  const content = message.content.trim();
  if (content) parts.push(content);
  else if (message.role === "assistant" && message.providerFailure) parts.push("[The reply failed.]");
  const attachmentCount = message.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    parts.push(attachmentCount === 1 ? "[1 attachment]" : `[${attachmentCount} attachments]`);
  }
  return redactBareCredentialTokens(parts.join("\n"), REDACTED);
}

/**
 * The newest `limit` user and assistant messages, oldest first, within
 * LIVE_CHAT_MAX_READ_CHARS. Older messages drop first; a single message
 * longer than what is left keeps its newest end. Tool activity becomes one
 * line, attachments only a count, and credential-shaped tokens are hidden.
 */
export function liveChatTranscript(
  messages: readonly LiveChatTranscriptMessage[],
  limit: number = LIVE_CHAT_DEFAULT_READ_MESSAGES,
): { messages: LiveChatReadMessage[]; truncated: boolean } {
  const count = Math.min(LIVE_CHAT_MAX_READ_MESSAGES, Math.max(1, Math.floor(limit)));
  const visible = messages.filter(
    (message): message is LiveChatTranscriptMessage & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant",
  );
  const recent = visible.slice(-count);
  let truncated = recent.length < visible.length;
  let budget = LIVE_CHAT_MAX_READ_CHARS;
  const kept: LiveChatReadMessage[] = [];
  for (let index = recent.length - 1; index >= 0 && budget > 0; index -= 1) {
    const message = recent[index]!;
    let text = messageText(message);
    if (text.length > budget) {
      text = `…${text.slice(text.length - budget + 1)}`;
      truncated = true;
    }
    budget -= text.length;
    kept.unshift({
      role: message.role,
      text,
      ...(message.role === "user" && message.inputSource === "voice" ? { byVoice: true as const } : {}),
    });
    if (budget <= 0 && index > 0) truncated = true;
  }
  return { messages: kept, truncated };
}

// ---------------------------------------------------------------------------
// send_to_open_chat

export interface LiveChatSendState {
  /** A reply is starting or running (this window's or a phone's). */
  busy: boolean;
  /** The running reply takes steering now (the composer's Steer would work). */
  steerAvailable: boolean;
  /** The chat has a queue (not a first-message draft). */
  queueAvailable: boolean;
  /** Queued messages are waiting their turn. */
  hasQueued: boolean;
}

export type LiveChatSendAction = "send" | "steer" | "queue" | { refuse: LiveChatError };

/** The composer's own rules, picked by mode: auto sends when idle and steers when busy. */
export function decideLiveChatSend(mode: LiveChatSendMode, state: LiveChatSendState): LiveChatSendAction {
  const idleSend = state.hasQueued && state.queueAvailable ? "queue" : "send";
  switch (mode) {
    case "steer":
      if (!state.busy) return { refuse: LIVE_CHAT_ERRORS.nothingToSteer };
      return state.steerAvailable ? "steer" : { refuse: LIVE_CHAT_ERRORS.cannotSteer };
    case "queue":
      if (!state.busy) return idleSend;
      return state.queueAvailable ? "queue" : { refuse: LIVE_CHAT_ERRORS.cannotQueue };
    case "auto":
      if (!state.busy) return idleSend;
      if (state.steerAvailable) return "steer";
      return state.queueAvailable ? "queue" : { refuse: LIVE_CHAT_ERRORS.cannotQueue };
  }
}

// ---------------------------------------------------------------------------
// find_and_open_chat

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How well a title answers a spoken query, from 0 (no match) to 1 (same title). */
export function liveChatTitleScore(title: string, query: string): number {
  const t = normalize(title);
  const q = normalize(query);
  if (!t || !q) return 0;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.9;
  if (t.includes(q)) return 0.8;
  const titleWords = t.split(" ");
  const queryWords = q.split(" ");
  let matched = 0;
  for (const word of queryWords) {
    if (titleWords.some((candidate) => candidate === word)) matched += 1;
    else if (word.length >= 3 && titleWords.some((candidate) => candidate.startsWith(word))) matched += 0.75;
  }
  return 0.7 * (matched / queryWords.length);
}

export interface LiveChatCandidate {
  id: string;
  title: string;
  updatedAt: number;
}

export type LiveChatFindResult =
  | { kind: "open"; chat: LiveChatCandidate }
  | { kind: "ambiguous"; titles: string[] }
  | { kind: "none" };

/** Scores below this are not a match at all. */
const MIN_SCORE = 0.35;
/** Matches this close to the best are "about as good"; Live then asks. */
const CLOSE_MARGIN = 0.1;

/**
 * The chat to open for a spoken title. One clear best match opens; when
 * several are about as good (including two chats with the same title),
 * nothing opens and the top three titles come back, most recent first.
 */
export function findLiveChat(chats: readonly LiveChatCandidate[], query: string): LiveChatFindResult {
  const scored = chats
    .map((chat) => ({ chat, score: liveChatTitleScore(chat.title, query) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt);
  const best = scored[0];
  if (!best) return { kind: "none" };
  // One chat with exactly that title wins over titles that merely contain it.
  if (best.score === 1 && (scored[1]?.score ?? 0) < 1) return { kind: "open", chat: best.chat };
  const close = scored.filter((entry) => entry.score >= best.score - (best.score === 1 ? 0 : CLOSE_MARGIN));
  if (close.length === 1) return { kind: "open", chat: best.chat };
  return {
    kind: "ambiguous",
    titles: close.slice(0, LIVE_CHAT_MAX_CANDIDATES).map((entry) => entry.chat.title),
  };
}

/** The workspace a spoken name means, or null when none or several match equally. */
export function findLiveWorkspace<T extends { id: string; name: string }>(
  workspaces: readonly T[],
  name: string,
): T | null {
  const scored = workspaces
    .map((workspace) => ({ workspace, score: liveChatTitleScore(workspace.name, name) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  if (scored[1] && scored[1].score >= best.score - CLOSE_MARGIN && best.score < 1) return null;
  return best.workspace;
}

// ---------------------------------------------------------------------------
// Spoken update notes

export type LiveChatNoteKind = "finished" | "failed" | "approval" | "question";

function quotedTitle(title: string): string {
  const clean = oneLine(redactBareCredentialTokens(title, REDACTED)) || "Untitled";
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/** One short note Live may mention aloud. Never carries the reply's text. */
export function liveChatNoteText(kind: LiveChatNoteKind, title: string): string {
  const name = `The chat “${quotedTitle(title)}”`;
  const text =
    kind === "finished"
      ? `${name} finished its reply.`
      : kind === "failed"
        ? `${name} stopped with an error.`
        : kind === "approval"
          ? `${name} is waiting for an approval.`
          : `${name} has a question for the user.`;
  return text.slice(0, LIVE_CHAT_MAX_NOTE_CHARS);
}
