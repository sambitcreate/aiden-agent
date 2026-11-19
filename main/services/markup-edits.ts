/**
 * Small text edits to a saved page's or visual's markup, so a model can fix
 * one field without sending the whole markup again. The edits are all or
 * nothing: each one's `old` text must appear exactly once in the markup as
 * the edits before it left it, and any miss changes nothing.
 */

import { safeCut } from "../../renderer/shared/workspace-artifacts.js";

export const MAX_MARKUP_EDITS = 32;
const EXCERPT_CHARS = 60;

export interface MarkupEdit {
  old: string;
  new: string;
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return JSON.stringify(line.length > EXCERPT_CHARS ? `${line.slice(0, safeCut(line, EXCERPT_CHARS - 1))}…` : line);
}

/** Reads `edits` from a tool call, or throws with what is wrong with it. */
export function parseMarkupEdits(value: unknown): MarkupEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edits must be a list of one or more { old, new } replacements.");
  }
  if (value.length > MAX_MARKUP_EDITS) {
    throw new Error(`edits can hold at most ${MAX_MARKUP_EDITS} replacements; send the whole markup instead.`);
  }
  return value.map((entry, index) => {
    const edit = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    if (typeof edit.old !== "string" || edit.old.length === 0) {
      throw new Error(`edits[${index}] needs old: the exact text to replace, copied from the markup.`);
    }
    if (typeof edit.new !== "string") throw new Error(`edits[${index}] needs new: the text to put in its place ("" removes it).`);
    return { old: edit.old, new: edit.new };
  });
}

function occurrences(markup: string, text: string): number {
  let count = 0;
  for (let at = markup.indexOf(text); at !== -1; at = markup.indexOf(text, at + 1)) count += 1;
  return count;
}

/** `text` with CRLF and lone CR line breaks as LF, and where each of its units came from in `text`. */
function lfOnly(text: string): { text: string; from: number[] } {
  let out = "";
  const from: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    from.push(at);
    if (text[at] === "\r") {
      out += "\n";
      if (text[at + 1] === "\n") at += 1;
    } else {
      out += text[at];
    }
  }
  from.push(text.length);
  return { text: out, from };
}

const LINE_BREAK = /\r\n|\r|\n/u;

/**
 * Where `old` is in `markup` and what replaces it there. An exact match comes
 * first. Failing that, `old` matches with its line breaks and the markup's
 * read alike (CRLF, CR and LF), and `replacement`'s line breaks take the
 * markup's own there, so a page saved with Windows line endings keeps them.
 */
function locate(
  markup: string,
  old: string,
  replacement: string,
): { count: number; alike: boolean; start: number; end: number; text: string } {
  const exact = occurrences(markup, old);
  const breaks = LINE_BREAK.test(markup) && /[\r\n]/u.test(old);
  const page = breaks ? lfOnly(markup) : undefined;
  const wanted = breaks ? lfOnly(old).text : "";
  const count = page ? occurrences(page.text, wanted) : 0;
  if (exact > 0 || !page) {
    const start = markup.indexOf(old);
    // An exact match is only one place if no other place matches once line
    // breaks are read alike, on a page that mixes CRLF and LF.
    if (exact === 1 && count > 1) return { count, alike: true, start, end: start + old.length, text: replacement };
    return { count: exact, alike: false, start, end: start + old.length, text: replacement };
  }
  const at = page.text.indexOf(wanted);
  const start = page.from[at] ?? -1;
  const end = page.from[at + wanted.length] ?? markup.length;
  const eol = (LINE_BREAK.exec(markup.slice(start, end)) ?? LINE_BREAK.exec(markup))?.[0] ?? "\n";
  return { count, alike: true, start, end, text: replacement.replace(/\r\n|\r|\n/gu, eol) };
}

/** What `at` cuts in two in `text`: a CRLF line break, a character of two UTF-16 units, or nothing. */
function splitAt(text: string, at: number): "line break" | "character" | undefined {
  if (at <= 0 || at >= text.length) return undefined;
  if (text[at - 1] === "\r" && text[at] === "\n") return "line break";
  return safeCut(text, at) === at ? undefined : "character";
}

/**
 * The markup with every edit applied in order, or a throw naming the first
 * edit whose old text is missing, appears more than once (counting places
 * that match only once line breaks are read alike), or starts or ends in the
 * middle of a CRLF line break or a two-unit character such as an emoji,
 * ending with `retry`. On a throw the caller changes nothing. Line breaks
 * match whatever their style (see `locate`).
 */
export function applyMarkupEdits(markup: string, edits: readonly MarkupEdit[], retry: string): string {
  let next = markup;
  edits.forEach((edit, index) => {
    const found = locate(next, edit.old, edit.new);
    const after = index > 0 ? " (as the edits before it left it)" : "";
    if (found.count !== 1) {
      const why =
        found.count === 0
          ? "was not found"
          : `was found ${found.count} times${found.alike ? " with its line breaks and the markup's read alike" : ""}; add surrounding text to old so it matches one place`;
      throw new Error(`edits[${index}] old ${excerpt(edit.old)} ${why} in the markup${after}. Nothing was changed. ${retry}`);
    }
    const split = splitAt(next, found.start) ?? splitAt(next, found.end);
    if (split) {
      const [what, fix] =
        split === "line break"
          ? ["between the \\r and \\n of a line break", "include the whole line break in old, or leave it out"]
          : ["inside a character made of two units, such as an emoji", "include the whole character in old"];
      throw new Error(`edits[${index}] old ${excerpt(edit.old)} starts or ends ${what} in the markup${after}; ${fix}. Nothing was changed. ${retry}`);
    }
    next = `${next.slice(0, found.start)}${found.text}${next.slice(found.end)}`;
  });
  return next;
}
