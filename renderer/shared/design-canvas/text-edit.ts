// Editing a page's words in place: where in the page's file a changed piece
// of text is, so a plain text change can be written straight into it.
//
// The page reports each text node it changed, as the browser read it (with
// entities decoded). A change lands only when its old text is found exactly
// once in the file's markup, outside tags, scripts, styles, comments and the
// title; when the edited element carries a `data-aiden-src` stamp, only that
// line and the few after it count. Anything else is the person's to hand to
// Aiden instead. Pure, so it is tested without a file.

export type DesignTextChange = { before: string; after: string };

export type DesignTextEditPlan =
  | { ok: true; source: string }
  | { ok: false; reason: "not-found" | "ambiguous" | "unchanged" | "too-long" };

export const DESIGN_TEXT_EDIT_LIMITS = {
  /** Most text nodes one edit changes. */
  changes: 20,
  /** Longest old or new text in one change. */
  chars: 4000,
  /** How many lines after a stamp the text may start on. */
  stampLines: 30,
} as const;

const ENTITY_ALTERNATIVES: Readonly<Record<string, string>> = {
  "&": "(?:&amp;|&#0*38;|&#x0*26;|&)",
  "<": "(?:&lt;|&#0*60;|&#x0*3c;)",
  ">": "(?:&gt;|&#0*62;|&#x0*3e;|>)",
  '"': '(?:&quot;|&#0*34;|&#x0*22;|")',
  "'": "(?:&apos;|&#0*39;|&#x0*27;|')",
  "\u00a0": "(?:&nbsp;|&#0*160;|&#x0*a0;|\u00a0)",
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A pattern for text as it may be written in markup: any entity spelling, any run of whitespace. */
function markupPattern(text: string): string {
  let pattern = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/u.test(char) && char !== "\u00a0") {
      while (index < text.length && /\s/u.test(text[index]!) && text[index] !== "\u00a0") index += 1;
      pattern += "\\s+";
      continue;
    }
    pattern += ENTITY_ALTERNATIVES[char] ?? escapeRegExp(char);
    index += 1;
  }
  return pattern;
}

/** Text written back into markup: only what has to be escaped is. */
export function escapeDesignText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/\u00a0/gu, "&nbsp;");
}

/** Ranges of the file where page text never is: tags, comments, scripts, styles and the title. */
function excludedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const blocks = /<!--[\s\S]*?(?:-->|$)|<(script|style|title|textarea|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<[^>]*>?/giu;
  for (let match = blocks.exec(source); match; match = blocks.exec(source)) {
    ranges.push([match.index, match.index + match[0].length]);
    if (match[0].length === 0) blocks.lastIndex += 1;
  }
  return ranges;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1 && at < index; at = source.indexOf("\n", at + 1)) line += 1;
  return line;
}

/** A stamp's line: `design/hero.html:12` is line 12, when it names this file. */
export function stampLine(stamp: string | undefined, path: string): number | undefined {
  if (!stamp) return undefined;
  const at = stamp.lastIndexOf(":");
  if (at <= 0 || stamp.slice(0, at) !== path) return undefined;
  const line = Number(stamp.slice(at + 1));
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function findOnce(source: string, before: string, line: number | undefined): { start: number; end: number } | "not-found" | "ambiguous" {
  const pattern = markupPattern(before);
  if (pattern.length === 0) return "not-found";
  const excluded = excludedRanges(source);
  const inside = (start: number, end: number) => excluded.some(([from, to]) => start < to && end > from);
  const found: Array<{ start: number; end: number }> = [];
  const search = new RegExp(pattern, "gu");
  for (let match = search.exec(source); match; match = search.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    if (match[0].length === 0) search.lastIndex += 1;
    if (inside(start, end)) continue;
    // A text node is whole: it runs from the end of one tag to the start of the next.
    if (start > 0 && source[start - 1] !== ">") continue;
    if (end < source.length && source[end] !== "<") continue;
    if (line !== undefined) {
      const at = lineAt(source, start);
      if (at < line || at > line + DESIGN_TEXT_EDIT_LIMITS.stampLines) continue;
    }
    found.push({ start, end });
    if (found.length > 1) return "ambiguous";
  }
  return found[0] ?? "not-found";
}

/**
 * Writes each change into the file's source, in order. Every change must be
 * found exactly once, or nothing is changed.
 */
export function planDesignTextEdit(
  source: string,
  changes: readonly DesignTextChange[],
  line?: number,
): DesignTextEditPlan {
  const real = changes.filter((change) => change.before !== change.after);
  if (real.length === 0) return { ok: false, reason: "unchanged" };
  if (
    real.length > DESIGN_TEXT_EDIT_LIMITS.changes ||
    real.some((change) => change.before.length > DESIGN_TEXT_EDIT_LIMITS.chars || change.after.length > DESIGN_TEXT_EDIT_LIMITS.chars)
  ) {
    return { ok: false, reason: "too-long" };
  }
  let next = source;
  for (const change of real) {
    if (change.before.trim().length === 0) return { ok: false, reason: "not-found" };
    const at = findOnce(next, change.before, line);
    if (typeof at === "string") return { ok: false, reason: at };
    next = next.slice(0, at.start) + escapeDesignText(change.after) + next.slice(at.end);
  }
  return { ok: true, source: next };
}

/** The same changes the other way round: what Undo writes. */
export function reverseDesignTextChanges(changes: readonly DesignTextChange[]): DesignTextChange[] {
  return [...changes].reverse().map((change) => ({ before: change.after, after: change.before }));
}
