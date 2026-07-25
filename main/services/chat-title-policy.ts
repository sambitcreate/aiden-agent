// Pure title seeding, prompting, and output normalization shared by chat
// persistence and background title generation.

import type { Attachment, ChatMessage } from "./types.js";

export const DEFAULT_CHAT_TITLE = "New agent";
/** Prior default kept replaceable so existing untitled chats still auto-rename. */
const LEGACY_DEFAULT_CHAT_TITLES = new Set(["new chat"]);
export const MAX_CHAT_TITLE_LENGTH = 50;
const CHAT_RENAME_ORIGINAL_BUDGET = 3_500;
const CHAT_RENAME_RECENT_BUDGET = 8_500;
const CHAT_RENAME_RECENT_MESSAGES = 8;

export function isDefaultChatTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === DEFAULT_CHAT_TITLE.toLowerCase() || LEGACY_DEFAULT_CHAT_TITLES.has(normalized)
  );
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  if (value.length <= MAX_CHAT_TITLE_LENGTH) return value;
  return `${value.slice(0, MAX_CHAT_TITLE_LENGTH - 3).trimEnd()}...`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maximumBytes < suffixBytes) return "";
  const contentBudget = maximumBytes - suffixBytes;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > contentBudget) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result.trimEnd()}${suffix}`;
}

function titleMessageExcerpt(message: ChatMessage): string {
  const label = message.role === "assistant" ? "Assistant" : "User";
  const content = compact(message.content);
  const attachments = (message.attachments ?? []).map(
    (attachment) => `${attachment.kind === "image" ? "Image" : "File"}: ${compact(attachment.name)}`,
  );
  const body = [content, ...attachments].filter(Boolean).join(" | ");
  return body ? `${label}: ${body}` : "";
}

export function deriveChatTitleSeed(input: {
  content: string;
  attachments?: Attachment[];
}): string {
  const message = compact(input.content);
  if (message) return truncate(message);

  const firstAttachment = input.attachments?.[0];
  if (!firstAttachment) return DEFAULT_CHAT_TITLE;
  const prefix = firstAttachment.kind === "image" ? "Image" : "File";
  return truncate(`${prefix}: ${compact(firstAttachment.name) || "Attachment"}`);
}

export function canReplaceGeneratedChatTitle(currentTitle: string, titleSeed: string): boolean {
  const current = currentTitle.trim();
  return isDefaultChatTitle(current) || current === titleSeed.trim();
}

function titleFromJson(value: string): string | null {
  if (!value.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : null;
  } catch {
    return null;
  }
}

export function sanitizeGeneratedChatTitle(raw: string): string | null {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const candidate = titleFromJson(unfenced) ?? unfenced;
  const firstLine = candidate
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim();
  if (!firstLine) return null;

  const normalized = compact(
    firstLine
      .replace(/^[-*#]+\s*/, "")
      .replace(/^(?:chat|thread)?\s*title\s*:\s*/i, "")
      .replace(/^[\s'"`]+|[\s'"`]+$/g, "")
      .replace(/[.!?;:]+$/g, ""),
  );
  return normalized ? truncate(normalized) : null;
}

export function buildChatTitlePrompt(input: {
  content: string;
  attachments?: Attachment[];
}): string {
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`,
  );
  return [
    "Write a concise title for this coding conversation.",
    "Return only the title, with no JSON, Markdown, quotes, or prefix.",
    "Rules:",
    "- Summarize the user's request instead of repeating it verbatim.",
    "- Keep it short and specific, ideally 3-8 words.",
    "- Do not end with punctuation.",
    "- If an image is attached, use it as primary context for visual or UI issues.",
    "",
    "User message:",
    input.content.slice(0, 8_000),
    ...(attachmentLines.length > 0 ? ["", "Attachment metadata:", ...attachmentLines] : []),
  ].join("\n");
}

/**
 * Build a bounded prompt for an explicit rename. The first user request anchors
 * the subject while a small recent transcript captures where the work evolved.
 * System messages and attachment contents stay out of the native request.
 */
export function buildChatRenamePrompt(messages: ChatMessage[]): string {
  const conversational = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const firstUserIndex = conversational.findIndex((message) => message.role === "user");
  const originalMessage = conversational[firstUserIndex >= 0 ? firstUserIndex : 0];
  const original = originalMessage
    ? truncateUtf8(titleMessageExcerpt(originalMessage), CHAT_RENAME_ORIGINAL_BUDGET)
    : "";

  const recentCandidates = conversational
    .filter((message) => message !== originalMessage)
    .slice(-CHAT_RENAME_RECENT_MESSAGES);
  const recent: string[] = [];
  let recentBytes = 0;
  for (let index = recentCandidates.length - 1; index >= 0; index -= 1) {
    const excerpt = titleMessageExcerpt(recentCandidates[index]);
    if (!excerpt) continue;
    const separatorBytes = recent.length > 0 ? 2 : 0;
    const remaining = CHAT_RENAME_RECENT_BUDGET - recentBytes - separatorBytes;
    if (remaining <= 0) break;
    const bounded = truncateUtf8(excerpt, Math.min(2_000, remaining));
    if (!bounded) break;
    recent.unshift(bounded);
    recentBytes += Buffer.byteLength(bounded, "utf8") + separatorBytes;
  }

  return [
    "Create a new title for this existing coding conversation.",
    "Return only the title, with no JSON, Markdown, quotes, or prefix.",
    "Rules:",
    "- Summarize the actual task or outcome instead of repeating a message verbatim.",
    "- Keep it short and specific, ideally 3-8 words.",
    "- Do not end with punctuation.",
    "- Use only facts in the conversation excerpts.",
    "",
    "Original user request:",
    original || "No user request was recorded.",
    ...(recent.length > 0 ? ["", "Recent conversation:", recent.join("\n\n")] : []),
  ].join("\n");
}
