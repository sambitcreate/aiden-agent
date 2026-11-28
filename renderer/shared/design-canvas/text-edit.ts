// Editing a page's words in place: where in the page's file a changed piece
// of text is, so a plain text change can be written straight into it.
//
// The page reports each text node it changed, as the browser read it (with
// entities decoded). A change lands only when its old text is found exactly
// once in the file's markup, outside tags, scripts, styles, comments and the
// title. When the edited element's `data-aiden-src` stamp names a line, that
// line and the few after it are searched first; a line gone stale (the file
// changed under it) falls back to the text whose nearest stamped element
// carries exactly that stamp, never to the rest of the file, so the words of
// another element are not changed. A stamp with no line means the whole file,
// which has to hold the text exactly once. Anything else is the person's to
// hand to Aiden instead. Pure, so it is tested without a file.

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
      while (index < text.length && /\s/u.test(text[index]!) && text[index] !== "\u00a0")
        index += 1;
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
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\u00a0/gu, "&nbsp;");
}

/** Ranges of the file where page text never is: tags, comments, scripts, styles and the title. */
function excludedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const blocks =
    /<!--[\s\S]*?(?:-->|$)|<(script|style|title|textarea|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<[^>]*>?/giu;
  for (let match = blocks.exec(source); match; match = blocks.exec(source)) {
    ranges.push([match.index, match.index + match[0].length]);
    if (match[0].length === 0) blocks.lastIndex += 1;
  }
  return ranges;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1 && at < index; at = source.indexOf("\n", at + 1))
    line += 1;
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

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text, never more elements; their tags are skipped with them. */
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "textarea", "template"]);

/**
 * The parts of the file whose nearest stamped element has `data-aiden-src`
 * exactly `stamp` (the value compared case for case): the inside of each
 * element stamped that way, from the end of its start tag to its end tag (or
 * the end of the file when it is never closed), less any element inside it
 * stamped another way, whose words the page reports under that other stamp.
 * Tags in comments, scripts and styles do not count. One pass over the tags,
 * so a page that stamps every element costs no more than one that stamps few.
 */
function stampedRanges(
  source: string,
  stamp: string,
  excluded: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
  // A tag of its own starts an excluded range; one inside a comment or script starts after it.
  let skip = 0;
  const inExcluded = (index: number) => {
    while (skip < excluded.length && excluded[skip]![1] <= index) skip += 1;
    return skip < excluded.length && excluded[skip]![0] < index;
  };
  const tags = /<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/giu;
  const attribute = /\sdata-aiden-src\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
  /** Open elements, outermost first, each with the stamp in force inside it. */
  const open: Array<{ name: string; stamp: string | undefined }> = [];
  const current = () => open[open.length - 1]?.stamp;
  const ranges: Array<[number, number]> = [];
  let from: number | undefined;
  /** Starts or ends a range at `at` when the stamp in force changes there. */
  const track = (at: number) => {
    const inside = current() === stamp;
    if (inside && from === undefined) from = at;
    if (!inside && from !== undefined) {
      if (at > from) ranges.push([from, at]);
      from = undefined;
    }
  };
  for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
    if (inExcluded(tag.index)) continue;
    const name = tag[2]!.toLowerCase();
    if (RAW_TEXT_TAGS.has(name)) continue;
    if (tag[1] === "/") {
      // An end tag closes its element and any left open inside it; one with nothing to close is ignored.
      const index = open.map((entry) => entry.name).lastIndexOf(name);
      if (index === -1) continue;
      open.length = index;
      track(tag.index);
      continue;
    }
    if (VOID_TAGS.has(name) || tag[3]!.endsWith("/")) continue;
    const own = attribute.exec(tag[3]!);
    open.push({ name, stamp: own ? (own[1] ?? own[2]) : current() });
    track(tag.index + tag[0].length);
  }
  if (from !== undefined && source.length > from) ranges.push([from, source.length]);
  return ranges;
}

type Where = { line: number } | { stamp: string } | undefined;

function findOnce(
  source: string,
  before: string,
  where: Where,
): { start: number; end: number } | "not-found" | "ambiguous" {
  const pattern = markupPattern(before);
  if (pattern.length === 0) return "not-found";
  const excluded = excludedRanges(source);
  const inside = (start: number, end: number) =>
    excluded.some(([from, to]) => start < to && end > from);
  const stamped =
    where && "stamp" in where ? stampedRanges(source, where.stamp, excluded) : undefined;
  if (stamped?.length === 0) return "not-found";
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
    if (where && "line" in where) {
      const at = lineAt(source, start);
      if (at < where.line || at > where.line + DESIGN_TEXT_EDIT_LIMITS.stampLines) continue;
    }
    if (stamped && !stamped.some(([from, to]) => start >= from && end <= to)) continue;
    found.push({ start, end });
    if (found.length > 1) return "ambiguous";
  }
  return found[0] ?? "not-found";
}

/**
 * Writes each change into the file's source, in order. Every change must be
 * found exactly once, or nothing is changed. `stamp` is the edited element's
 * nearest `data-aiden-src` and `path` the page's file; a stamp naming another
 * file counts for nothing.
 */
export function planDesignTextEdit(
  source: string,
  changes: readonly DesignTextChange[],
  stamp?: { stamp: string | undefined; path: string },
): DesignTextEditPlan {
  const line = stamp ? stampLine(stamp.stamp, stamp.path) : undefined;
  const real = changes.filter((change) => change.before !== change.after);
  if (real.length === 0) return { ok: false, reason: "unchanged" };
  if (
    real.length > DESIGN_TEXT_EDIT_LIMITS.changes ||
    real.some(
      (change) =>
        change.before.length > DESIGN_TEXT_EDIT_LIMITS.chars ||
        change.after.length > DESIGN_TEXT_EDIT_LIMITS.chars,
    )
  ) {
    return { ok: false, reason: "too-long" };
  }
  let next = source;
  for (const change of real) {
    if (change.before.trim().length === 0) return { ok: false, reason: "not-found" };
    // A stale line misses: look inside the elements stamped the same way,
    // where the text must still be unique, and nowhere else.
    let at = findOnce(next, change.before, line === undefined ? undefined : { line });
    if (at === "not-found" && line !== undefined)
      at = findOnce(next, change.before, { stamp: stamp!.stamp! });
    if (typeof at === "string") return { ok: false, reason: at };
    next = next.slice(0, at.start) + escapeDesignText(change.after) + next.slice(at.end);
  }
  return { ok: true, source: next };
}

/** The same changes the other way round: what Undo writes. */
export function reverseDesignTextChanges(changes: readonly DesignTextChange[]): DesignTextChange[] {
  return [...changes].reverse().map((change) => ({ before: change.after, after: change.before }));
}
