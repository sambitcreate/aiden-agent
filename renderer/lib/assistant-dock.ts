// Presentation helpers for the docked Aiden bubble. Pure so the badge and
// preview rules stay testable without a DOM.

const PREVIEW_MAX_CHARS = 80;
const BADGE_MAX = 9;
const ASSISTANT_AUTOMATION_COMPOSE_EVENT = "aiden:assistant-create-automation";

export const ASSISTANT_AUTOMATION_DRAFT = "Create an automation that ";

/** Preserve anything the user was already composing when another surface opens Aiden. */
export function assistantAutomationDraft(currentDraft: string): string {
  return currentDraft.trim() ? currentDraft : ASSISTANT_AUTOMATION_DRAFT;
}

export function requestAssistantAutomationComposer(): void {
  window.dispatchEvent(new Event(ASSISTANT_AUTOMATION_COMPOSE_EVENT));
}

export function onAssistantAutomationComposerRequested(handler: () => void): () => void {
  window.addEventListener(ASSISTANT_AUTOMATION_COMPOSE_EVENT, handler);
  return () => window.removeEventListener(ASSISTANT_AUTOMATION_COMPOSE_EVENT, handler);
}

/** Badge text for unread Aiden messages, or null when there is nothing to show. */
export function unreadBadgeLabel(unread: number): string | null {
  if (!Number.isFinite(unread) || unread < 1) return null;
  return unread > BADGE_MAX ? `${String(BADGE_MAX)}+` : String(Math.floor(unread));
}

/**
 * A one-line plain-text preview of a reply, for the bubble beside the minimized
 * icon. Light Markdown stripping only: the bubble is a glance, not a renderer,
 * and leaving `**` or `#` in it reads as noise at this size.
 */
export function assistantPreviewText(content: string): string | null {
  const flat = content
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/gu, "$1$2")
    // Model output is untrusted text rendered in app chrome. Bidi overrides and
    // other invisible formatting characters let it display something other than
    // what it says — a reversed line in a bubble styled like the app's own.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!flat) return null;
  // Count by code point: a UTF-16 slice can cut a surrogate pair in half and
  // leave a replacement character at the end of the preview.
  const points = [...flat];
  if (points.length <= PREVIEW_MAX_CHARS) return flat;
  const clipped = points.slice(0, PREVIEW_MAX_CHARS).join("");
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
