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
function locate(markup: string, old: string, replacement: string): { count: number; start: number; end: number; text: string } {
  const exact = occurrences(markup, old);
  if (exact > 0 || !LINE_BREAK.test(markup) || !/[\r\n]/u.test(old)) {
    const start = markup.indexOf(old);
    return { count: exact, start, end: start + old.length, text: replacement };
  }
  const page = lfOnly(markup);
  const wanted = lfOnly(old).text;
  const count = occurrences(page.text, wanted);
  const at = page.text.indexOf(wanted);
  const start = page.from[at] ?? -1;
  const end = page.from[at + wanted.length] ?? markup.length;
  const eol = (LINE_BREAK.exec(markup.slice(start, end)) ?? LINE_BREAK.exec(markup))?.[0] ?? "\n";
  return { count, start, end, text: replacement.replace(/\r\n|\r|\n/gu, eol) };
}

/**
 * The markup with every edit applied in order, or a throw naming the first
 * edit whose old text is missing or appears more than once, ending with
 * `retry`. On a throw the caller changes nothing. Line breaks match whatever
 * their style (see `locate`).
 */
export function applyMarkupEdits(markup: string, edits: readonly MarkupEdit[], retry: string): string {
  let next = markup;
  edits.forEach((edit, index) => {
    const found = locate(next, edit.old, edit.new);
    if (found.count !== 1) {
      const why =
        found.count === 0
          ? "was not found"
          : `was found ${found.count} times; add surrounding text to old so it matches one place`;
      const after = index > 0 ? " (as the edits before it left it)" : "";
      throw new Error(`edits[${index}] old ${excerpt(edit.old)} ${why} in the markup${after}. Nothing was changed. ${retry}`);
    }
    next = `${next.slice(0, found.start)}${found.text}${next.slice(found.end)}`;
  });
  return next;
}
