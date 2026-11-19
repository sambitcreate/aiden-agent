// How a picker matches what was typed: case and accents don't count, a match at
// the start of a word ranks above one inside it, and the matched part of a
// label is returned as ranges so the row can highlight it. Folding keeps every
// character in place (one UTF-16 unit for one), so a range in the folded text
// is the same range in the label.

/** A matched part of a text, from `start` up to `end`, like `slice`. */
export interface MatchRange {
  start: number;
  end: number;
}

export interface TextMatch {
  /** Higher ranks first; equal scores keep their input order. */
  score: number;
  /** What to highlight in the text; empty when only a keyword matched. */
  ranges: MatchRange[];
}

export interface MatchSegment {
  text: string;
  match: boolean;
}

// Score tiers, best first. A keyword (a field the row doesn't show as its
// title) can match but is never highlighted.
const PREFIX = 400;
const WORD_START = 300;
const CONTAINS = 200;
const INITIALS = 150;
const KEYWORD_WORD_START = 140;
const KEYWORD_CONTAINS = 120;
const ALL_WORDS = 110;
const LETTERS = 100;

const ASCII = /^\p{ASCII}*$/u;
const MARKS = /\p{M}/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const folded = new Map<string, string>();

/**
 * Lowercases and strips accents, keeping the text's length so its indexes are
 * the original's. A character whose fold would change length (Hangul syllables
 * decompose into jamo) keeps its plain lowercase, or itself.
 */
export function fold(text: string): string {
  const cached = folded.get(text);
  if (cached !== undefined) return cached;
  let result: string;
  if (ASCII.test(text)) {
    result = text.toLowerCase();
  } else {
    result = "";
    for (const character of text) {
      const stripped = character.normalize("NFD").replace(MARKS, "").toLowerCase();
      if (stripped.length === character.length) {
        result += stripped;
      } else {
        const lower = character.toLowerCase();
        result += lower.length === character.length ? lower : character;
      }
    }
  }
  // Bounded, so labels that come and go can't grow it forever.
  if (folded.size > 20_000) folded.clear();
  folded.set(text, result);
  return result;
}

// A decomposed query ("e" + combining accent) folds like the composed label.
const foldQuery = (query: string) => fold(query.normalize("NFC").trim());

function startsWord(original: string, haystack: string, index: number): boolean {
  if (index === 0) return true;
  const previous = haystack[index - 1];
  if (!WORD_CHARACTER.test(previous)) return true;
  // camelCase: "gitPush" starts a word at "P".
  const before = original[index - 1];
  const at = original[index];
  return before !== before.toUpperCase() && at !== at.toLowerCase();
}

/** The query's letters on consecutive-or-skipped word starts, in order: "gp" in "Git push". */
function initials(original: string, haystack: string, letters: string): MatchRange[] | null {
  const ranges: MatchRange[] = [];
  let next = 0;
  for (let index = 0; index < haystack.length && next < letters.length; index += 1) {
    if (haystack[index] === letters[next] && startsWord(original, haystack, index)) {
      // Join neighbours, so a surrogate pair (an emoji) is never split across marks.
      const last = ranges[ranges.length - 1];
      if (last && last.end === index) last.end = index + 1;
      else ranges.push({ start: index, end: index + 1 });
      next += 1;
    }
  }
  return next === letters.length ? ranges : null;
}

/** Each letter in order, with neighbours joined into one range. */
function letterRanges(haystack: string, letters: string): MatchRange[] | null {
  const ranges: MatchRange[] = [];
  let position = 0;
  for (const letter of letters) {
    const found = haystack.indexOf(letter, position);
    if (found === -1) return null;
    const last = ranges[ranges.length - 1];
    const end = found + letter.length;
    if (last && last.end === found) last.end = end;
    else ranges.push({ start: found, end });
    position = end;
  }
  return ranges;
}

/**
 * How `text` matches `query`: the whole query where it appears (at the start,
 * then at a word start, then anywhere), else the query's letters as word
 * initials, else its letters in order. Null when it doesn't match. An empty
 * query matches everything with no ranges.
 */
export function matchText(text: string, query: string): TextMatch | null {
  const needle = foldQuery(query);
  if (!needle) return { score: 0, ranges: [] };
  const haystack = fold(text);
  let index = haystack.indexOf(needle);
  if (index === 0) return { score: PREFIX, ranges: [{ start: 0, end: needle.length }] };
  if (index !== -1) {
    const first = index;
    while (index !== -1 && !startsWord(text, haystack, index)) {
      index = haystack.indexOf(needle, index + 1);
    }
    return index === -1
      ? { score: CONTAINS, ranges: [{ start: first, end: first + needle.length }] }
      : { score: WORD_START, ranges: [{ start: index, end: index + needle.length }] };
  }
  const letters = needle.replace(/\s+/gu, "");
  if (letters.length < 2) return null;
  const wordInitials = initials(text, haystack, letters);
  if (wordInitials) return { score: INITIALS, ranges: wordInitials };
  const inOrder = letterRanges(haystack, letters);
  return inOrder ? { score: LETTERS, ranges: inOrder } : null;
}

/**
 * The ranges to mark in a title whose row was ranked elsewhere: only a whole,
 * word-start or initials match, never scattered letters.
 */
export function titleRanges(title: string, query: string): MatchRange[] {
  const match = matchText(title, query);
  return match && match.score >= INITIALS ? match.ranges : [];
}

/** Whether a keyword contains the query, and where: keywords never match by letters. */
function keywordScore(keyword: string, needle: string): number {
  const haystack = fold(keyword);
  let index = haystack.indexOf(needle);
  if (index === -1) return 0;
  while (index !== -1) {
    if (startsWord(keyword, haystack, index)) return KEYWORD_WORD_START;
    index = haystack.indexOf(needle, index + 1);
  }
  return KEYWORD_CONTAINS;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * A row's match: its shown title first (highlighted), then its keywords
 * (matched, never highlighted), then every typed word somewhere in either.
 */
export function matchItem(title: string, keywords: readonly string[], query: string): TextMatch | null {
  const titleMatch = matchText(title, query);
  if (titleMatch && titleMatch.score >= INITIALS) return titleMatch;
  const needle = foldQuery(query);
  let best = 0;
  for (const keyword of keywords) best = Math.max(best, keywordScore(keyword, needle));
  if (best > 0) return { score: best, ranges: [] };
  const words = needle.split(/\s+/u);
  if (words.length > 1) {
    const ranges: MatchRange[] = [];
    const foldedTitle = fold(title);
    const allFound = words.every((word) => {
      const index = foldedTitle.indexOf(word);
      if (index !== -1) {
        ranges.push({ start: index, end: index + word.length });
        return true;
      }
      return keywords.some((keyword) => fold(keyword).includes(word));
    });
    if (allFound) return { score: ALL_WORDS, ranges: mergeRanges(ranges) };
  }
  return titleMatch;
}

/**
 * The items that match, best first, ties in input order. An empty query keeps
 * every item in order with no highlight.
 */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => { title: string; keywords?: readonly string[] },
): Array<{ item: T; ranges: MatchRange[] }> {
  if (!query.trim()) return items.map((item) => ({ item, ranges: [] }));
  const matched: Array<{ item: T; ranges: MatchRange[]; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const { title, keywords = [] } = fields(item);
    const match = matchItem(title, keywords, query);
    if (match) matched.push({ item, ranges: match.ranges, score: match.score, index });
  });
  matched.sort((left, right) => right.score - left.score || left.index - right.index);
  return matched.map(({ item, ranges }) => ({ item, ranges }));
}

/** Text split into the parts that matched and the parts that didn't, in order. */
export function matchSegments(text: string, ranges: readonly MatchRange[]): MatchSegment[] {
  if (!ranges.length) return [{ text, match: false }];
  const segments: MatchSegment[] = [];
  let position = 0;
  for (const { start, end } of ranges) {
    if (start > position) segments.push({ text: text.slice(position, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    position = end;
  }
  if (position < text.length) segments.push({ text: text.slice(position), match: false });
  return segments;
}
