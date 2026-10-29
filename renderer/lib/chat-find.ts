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

interface FoldedText {
  text: string;
  /** For each code unit of `text`, where its character starts and ends in the original. */
  starts: number[] | null;
  ends: number[] | null;
}

// Lowercasing can lengthen a character (İ becomes i + a combining dot), so
// offsets in the folded text are mapped back to the original's.
function foldCase(original: string): FoldedText {
  const lower = original.toLocaleLowerCase();
  if (lower.length === original.length) return { text: lower, starts: null, ends: null };
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let at = 0; at < original.length; ) {
    const character = String.fromCodePoint(original.codePointAt(at)!);
    const next = at + character.length;
    const folded = character.toLocaleLowerCase();
    for (let unit = 0; unit < folded.length; unit += 1) {
      starts.push(at);
      ends.push(next);
    }
    text += folded;
    at = next;
  }
  return { text, starts, ends };
}

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
    const haystack = foldCase(node.nodeValue ?? "");
    for (let at = haystack.text.indexOf(needle); at >= 0; at = haystack.text.indexOf(needle, at + needle.length)) {
      const last = at + needle.length - 1;
      const range = document.createRange();
      range.setStart(node, haystack.starts ? haystack.starts[at]! : at);
      range.setEnd(node, haystack.ends ? haystack.ends[last]! : last + 1);
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
