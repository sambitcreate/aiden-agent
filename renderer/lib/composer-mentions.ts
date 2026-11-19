// `@` mentions of workspace files in the composer. Pure: the trigger rule,
// how a pick leaves the draft, how picks rank, and how they are written into
// the sent message, so every rule here is unit tested.
import { rankMatches, type MatchRange } from "./text-match";
import type { WorkspaceFileEntry } from "./types";

/** An `@` before the caret and the path-like text typed after it. */
export interface MentionTrigger {
  /** Where the `@` is. */
  start: number;
  /** Where the token ends: the caret, or past it when the caret sits mid-word. */
  end: number;
  /** The text between the `@` and the caret. */
  query: string;
}

/** A picked file or folder. It lives in a chip above the text, never in it. */
export interface ComposerMention {
  path: string;
  kind: "file" | "directory";
}

export interface MentionCandidate {
  entry: WorkspaceFileEntry & { kind: "file" | "directory" };
  /** What to mark in the entry's name. */
  ranges: MatchRange[];
}

const QUERY_CHARACTER = /[\p{L}\p{N}\p{M}_\-./~+]/u;
const MAX_QUERY_LENGTH = 120;
const MAX_CANDIDATES = 50;
// After these an `@` starts a word: an opening bracket or quote.
const OPENERS = new Set(["(", "[", "{", '"', "'"]);

// A Japanese keyboard commits the full-width ＠; it is one UTF-16 unit, like "@".
function isAt(character: string | undefined): boolean {
  return character === "@" || character === "＠";
}

function isQueryCharacter(character: string | undefined): boolean {
  return character !== undefined && QUERY_CHARACTER.test(character);
}

/**
 * The mention being typed at the caret: an `@` at the start, after whitespace
 * or an opening bracket or quote, followed by path characters up to the caret.
 * An email address (`me@example.com`) never matches: its `@` is mid-word.
 */
export function findMentionTrigger(draft: string, caret: number): MentionTrigger | null {
  if (caret < 1 || caret > draft.length) return null;
  let index = caret - 1;
  while (index >= 0 && caret - index <= MAX_QUERY_LENGTH + 1) {
    const character = draft[index];
    if (isAt(character)) {
      const before = draft[index - 1];
      if (index > 0 && !/\s/u.test(before!) && !OPENERS.has(before!)) return null;
      let end = caret;
      while (isQueryCharacter(draft[end])) end += 1;
      if (end - index - 1 > MAX_QUERY_LENGTH) return null;
      return { start: index, end, query: draft.slice(index + 1, caret) };
    }
    if (!isQueryCharacter(character)) return null;
    index -= 1;
  }
  return null;
}

/** The draft with the typed `@query` taken out, and where the caret goes. */
export function removeMentionTrigger(
  draft: string,
  trigger: Pick<MentionTrigger, "start" | "end">,
): { text: string; caret: number } {
  const before = draft.slice(0, trigger.start);
  let after = draft.slice(trigger.end);
  // "see @co here" leaves "see here", not "see  here".
  if ((before === "" || /\s$/u.test(before)) && after.startsWith(" ")) after = after.slice(1);
  return { text: before + after, caret: before.length };
}

/**
 * Files and folders that match, best first: the name is the title (and what is
 * marked), the path is a keyword so "lib/text" finds `renderer/lib/text-match.ts`.
 */
export function rankMentionCandidates(
  entries: readonly WorkspaceFileEntry[],
  query: string,
  limit = MAX_CANDIDATES,
): MentionCandidate[] {
  const pickable = entries.filter(
    (entry): entry is MentionCandidate["entry"] => entry.kind === "file" || entry.kind === "directory",
  );
  return rankMatches(pickable, query, (entry) => ({
    title: entry.name,
    // "dir/" is how a folder is written, so it finds the folder itself.
    keywords: entry.kind === "directory" ? [entry.path, `${entry.path}/`] : [entry.path],
  }))
    .slice(0, limit)
    .map(({ item, ranges }) => ({ entry: item, ranges }));
}

/** Adds a pick at the end; a path already mentioned stays where it is. */
export function addMention(
  mentions: readonly ComposerMention[],
  mention: ComposerMention,
): ComposerMention[] {
  return mentions.some((current) => current.path === mention.path)
    ? [...mentions]
    : [...mentions, mention];
}

/**
 * How a mention is written in the sent message: `@path`, `@path/` for a
 * folder, and `@"path"` when the path has whitespace or a quote.
 */
export function formatMention(mention: ComposerMention): string {
  const path = mention.kind === "directory" ? `${mention.path.replace(/\/+$/u, "")}/` : mention.path;
  return /[\s"]/u.test(path) ? `@"${path.replace(/"/gu, '\\"')}"` : `@${path}`;
}

/** The message text with its mentions first, in chip order, then what was typed. */
export function messageWithMentions(mentions: readonly ComposerMention[], text: string): string {
  if (mentions.length === 0) return text;
  const prefix = mentions.map(formatMention).join(" ");
  return text ? `${prefix} ${text}` : prefix;
}
