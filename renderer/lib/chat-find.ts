// Find in chat: the text ranges in a conversation that match what someone
// typed, ignoring case. The matches are painted with the CSS Custom Highlight
// API, so the transcript's own DOM is never changed. A match has to sit inside
// one run of text; a word split by formatting (half bold) is not found.

/** Stop counting here; the bar then says "1,000+". */
export const CHAT_FIND_MATCH_LIMIT = 1000;

export const CHAT_FIND_HIGHLIGHT = "aiden-find";
export const CHAT_FIND_CURRENT_HIGHLIGHT = "aiden-find-current";

// Text a reader can't see, and the bar's own text, are never matches.
const SKIPPED = "script, style, [hidden], [aria-hidden='true'], [data-chat-find-skip]";

export function findChatMatches(root: Node, query: string, limit = CHAT_FIND_MATCH_LIMIT): Range[] {
  const needle = query.toLocaleLowerCase();
  if (!needle.trim()) return [];
  const document = root.ownerDocument ?? (root as Document);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const haystack = (node.nodeValue ?? "").toLocaleLowerCase();
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      if (ranges.length >= limit) return ranges;
    }
  }
  return ranges;
}

type HighlightRegistry = Map<string, unknown>;
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

/** Paint every match, and the current one on top. Without the API nothing is painted. */
export function paintChatMatches(ranges: readonly Range[], current: number): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.set(CHAT_FIND_HIGHLIGHT, new api.Highlight(...ranges));
  const active = ranges[current];
  if (active) api.registry.set(CHAT_FIND_CURRENT_HIGHLIGHT, new api.Highlight(active));
  else api.registry.delete(CHAT_FIND_CURRENT_HIGHLIGHT);
}

export function clearChatMatches(): void {
  const api = highlightApi();
  api?.registry.delete(CHAT_FIND_HIGHLIGHT);
  api?.registry.delete(CHAT_FIND_CURRENT_HIGHLIGHT);
}

/** "3 of 12", "1,000+ matches" past the limit, or "No matches". */
export function chatFindStatus(count: number, current: number, limit = CHAT_FIND_MATCH_LIMIT): string {
  if (count === 0) return "No matches";
  const total = count >= limit ? `${limit.toLocaleString()}+` : count.toLocaleString();
  return `${(current + 1).toLocaleString()} of ${total}`;
}
