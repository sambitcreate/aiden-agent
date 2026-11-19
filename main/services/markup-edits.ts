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

/**
 * A short quote of an edit's old text for an error. Runs of spaces and tabs
 * read as one space, but line breaks stay, written as `\n` and `\r`, since
 * they can be what the error is about. A long text keeps its start, or its
 * end when `from` is "end" because the refused part is there.
 */
function excerpt(text: string, from: "start" | "end" = "start"): string {
  const line = text.replace(/[ \t]+/gu, " ");
  if (line.length <= EXCERPT_CHARS) return JSON.stringify(line);
  if (from === "start") return JSON.stringify(`${line.slice(0, safeCut(line, EXCERPT_CHARS - 1))}…`);
  const at = line.length - (EXCERPT_CHARS - 1);
  return JSON.stringify(`…${line.slice(at === safeCut(line, at) ? at : at + 1)}`);
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

/** Whether `at` falls between the `\r` and `\n` of a CRLF line break in `text`. */
function insideLineBreak(text: string, at: number): boolean {
  return at > 0 && at < text.length && text[at - 1] === "\r" && text[at] === "\n";
}

function exactMatches(markup: string, text: string): number[] {
  const starts: number[] = [];
  for (let at = markup.indexOf(text); at !== -1; at = markup.indexOf(text, at + 1)) starts.push(at);
  return starts;
}

interface Located {
  count: number;
  alike: boolean;
  start: number;
  end: number;
  text: string;
  /** Set when the only exact match ends between a CRLF's `\r` and `\n`. */
  halfLineBreak?: boolean;
}

/**
 * Where `old` is in `markup` and what replaces it there. An exact match comes
 * first, but not one that starts or ends between the `\r` and `\n` of a CRLF:
 * an `old` starting with `\n` there means the whole line break, and is found
 * with line breaks read alike instead. Failing an exact match, `old` matches
 * with its line breaks and the markup's read alike (CRLF, CR and LF), and
 * `replacement`'s line breaks take the markup's own there, so a page saved
 * with Windows line endings keeps them. An `old` that ends in a lone `\r`
 * just before a CRLF's `\n`, and matches nowhere else, could mean the `\r`
 * alone or the whole line break, so it is reported rather than guessed.
 */
function locate(markup: string, old: string, replacement: string): Located {
  const breaks = LINE_BREAK.test(markup) && /[\r\n]/u.test(old);
  const page = breaks ? lfOnly(markup) : undefined;
  const wanted = breaks ? lfOnly(old).text : "";
  const count = page ? exactMatches(page.text, wanted).length : 0;
  const exact = exactMatches(markup, old);
  const whole = exact.filter((at) => !insideLineBreak(markup, at) && !insideLineBreak(markup, at + old.length));
  if (whole.length > 0 || !page) {
    const start = whole[0] ?? -1;
    // An exact match is only one place if no other place matches once line
    // breaks are read alike, on a page that mixes CRLF and LF.
    if (whole.length === 1 && count > 1) return { count, alike: true, start, end: start + old.length, text: replacement };
    return { count: whole.length, alike: false, start, end: start + old.length, text: replacement };
  }
  const half = exact.find((at) => insideLineBreak(markup, at + old.length));
  if (half !== undefined) return { count: 1, alike: false, start: half, end: half + old.length, text: replacement, halfLineBreak: true };
  const at = page.text.indexOf(wanted);
  const start = page.from[at] ?? -1;
  const end = page.from[at + wanted.length] ?? markup.length;
  const eol = (LINE_BREAK.exec(markup.slice(start, end)) ?? LINE_BREAK.exec(markup))?.[0] ?? "\n";
  return { count, alike: true, start, end, text: replacement.replace(/\r\n|\r|\n/gu, eol) };
}

/** Whether `at` cuts a character of two UTF-16 units in two in `text`. */
function splitsCharacter(text: string, at: number): boolean {
  return at > 0 && at < text.length && safeCut(text, at) !== at;
}

/**
 * The markup with every edit applied in order, or a throw naming the first
 * edit whose old text is missing, appears more than once (counting places
 * that match only once line breaks are read alike), ends between the `\r`
 * and `\n` of a CRLF line break, or starts or ends in the middle of a
 * two-unit character such as an emoji, ending with `retry`. On a throw the
 * caller changes nothing. Line breaks match whatever their style (see
 * `locate`).
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
    if (found.halfLineBreak) {
      throw new Error(
        `edits[${index}] old ${excerpt(edit.old, "end")} ends between the \\r and \\n of a line break in the markup${after}; include the whole line break in old, or leave it out. Nothing was changed. ${retry}`,
      );
    }
    if (splitsCharacter(next, found.start) || splitsCharacter(next, found.end)) {
      throw new Error(
        `edits[${index}] old ${excerpt(edit.old, splitsCharacter(next, found.start) ? "start" : "end")} starts or ends inside a character made of two units, such as an emoji in the markup${after}; include the whole character in old. Nothing was changed. ${retry}`,
      );
    }
    next = `${next.slice(0, found.start)}${found.text}${next.slice(found.end)}`;
  });
  return next;
}
