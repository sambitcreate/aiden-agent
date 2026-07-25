// Presentation helpers for the docked Aiden bubble. Pure so the badge and
// preview rules stay testable without a DOM.

const PREVIEW_MAX_CHARS = 80;
const BADGE_MAX = 9;

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
    .replace(/\s+/gu, " ")
    .trim();
  if (!flat) return null;
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  const clipped = flat.slice(0, PREVIEW_MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
