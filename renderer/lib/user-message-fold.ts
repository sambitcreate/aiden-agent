// When a sent prompt folds behind a "show full message" disclosure.
//
// The bubble measures its wrapped height once it has laid out, since the line
// count depends on the chat width, font size, and window. Before that (first
// paint, server markup, a row whose layout is still deferred) a character and
// line count stands in, so a long paste never flashes at full height first.

/** Lines a folded prompt keeps visible. */
export const USER_MESSAGE_FOLD_LINES = 6;

// Fold only when at least this many more lines would be hidden, so a single
// stray line never sits behind a disclosure.
const MIN_HIDDEN_LINES = 2;

// Roughly six lines of bubble text at the default chat width.
const FIRST_PAINT_FOLD_CHARS = 320;

/** The first-paint guess, before the bubble's wrapped height is known. */
export function userMessageMayFold(content: string): boolean {
  if (content.length > FIRST_PAINT_FOLD_CHARS) return true;
  let lines = 1;
  for (const char of content) if (char === "\n") lines += 1;
  return lines >= USER_MESSAGE_FOLD_LINES + MIN_HIDDEN_LINES;
}

/** Whether a laid-out body of this full height folds at this line height. */
export function userMessageFolds(contentHeight: number, lineHeight: number): boolean {
  if (!(lineHeight > 0) || !(contentHeight > 0)) return false;
  // Half a line of slack absorbs sub-pixel rounding in the measured height.
  return contentHeight > lineHeight * (USER_MESSAGE_FOLD_LINES + MIN_HIDDEN_LINES - 0.5);
}
