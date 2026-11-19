/**
 * Small text edits to a saved page's or visual's markup, so a model can fix
 * one field without sending the whole markup again. The edits are all or
 * nothing: each one's `old` text must appear exactly once in the markup as
 * the edits before it left it, and any miss changes nothing.
 */

export const MAX_MARKUP_EDITS = 32;
const EXCERPT_CHARS = 60;

export interface MarkupEdit {
  old: string;
  new: string;
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return JSON.stringify(line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line);
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

/**
 * The markup with every edit applied in order, or a throw naming the first
 * edit whose old text is missing or appears more than once, ending with
 * `retry`. On a throw the caller changes nothing.
 */
export function applyMarkupEdits(markup: string, edits: readonly MarkupEdit[], retry: string): string {
  let next = markup;
  edits.forEach((edit, index) => {
    const count = occurrences(next, edit.old);
    if (count !== 1) {
      const why =
        count === 0
          ? "was not found"
          : `was found ${count} times; add surrounding text to old so it matches one place`;
      const after = index > 0 ? " (as the edits before it left it)" : "";
      throw new Error(`edits[${index}] old ${excerpt(edit.old)} ${why} in the markup${after}. Nothing was changed. ${retry}`);
    }
    const at = next.indexOf(edit.old);
    next = `${next.slice(0, at)}${edit.new}${next.slice(at + edit.old.length)}`;
  });
  return next;
}
