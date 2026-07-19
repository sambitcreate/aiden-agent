// Pure title seeding, prompting, and output normalization shared by chat
// persistence and background title generation.

import type { Attachment } from "./types.js";

export const DEFAULT_CHAT_TITLE = "New chat";
export const MAX_CHAT_TITLE_LENGTH = 50;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string): string {
  if (value.length <= MAX_CHAT_TITLE_LENGTH) return value;
  return `${value.slice(0, MAX_CHAT_TITLE_LENGTH - 3).trimEnd()}...`;
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
  return current.toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase() || current === titleSeed.trim();
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
