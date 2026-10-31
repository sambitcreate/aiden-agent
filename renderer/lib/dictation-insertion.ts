// Where a composer dictation lands: at the caret, replacing any selection,
// with spaces only where the transcript would otherwise touch another word.

export interface DictationInsertion {
  /** Text that replaces `start`..`end`, spacing included. */
  insert: string;
  start: number;
  end: number;
  /** Caret after the transcript (before any trailing space). */
  caret: number;
  /** The whole draft after the insertion. */
  text: string;
}

const STARTS_WITH_WORD = /^[\p{L}\p{N}]/u;
const ENDS_WITH_SPACE = /\s$/u;

/** `selection` is the textarea's; without one the transcript goes at the end. */
export function dictationInsertion(
  draft: string,
  selection: { start: number; end: number } | null,
  transcript: string,
): DictationInsertion {
  const clamp = (value: number) => Math.max(0, Math.min(draft.length, value));
  const start = selection ? clamp(Math.min(selection.start, selection.end)) : draft.length;
  const end = selection ? clamp(Math.max(selection.start, selection.end)) : draft.length;
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before.length > 0 && !ENDS_WITH_SPACE.test(before) ? " " : "";
  const trail = STARTS_WITH_WORD.test(after) ? " " : "";
  const insert = `${lead}${transcript}${trail}`;
  return {
    insert,
    start,
    end,
    caret: start + lead.length + transcript.length,
    text: `${before}${insert}${after}`,
  };
}
