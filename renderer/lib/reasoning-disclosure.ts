/**
 * A reasoning disclosure only moves when the reader asks it to. Closing eases
 * shut first when motion is allowed, so the body stays mounted while it folds.
 */
export type ReasoningDisclosurePhase = "closed" | "open" | "closing";

export type ReasoningDisclosureEvent =
  /** The reader pressed the header. `animate` is false under Reduce Motion. */
  | { type: "toggle"; animate: boolean }
  /** The closing fold finished. */
  | { type: "closed" };

export function reduceReasoningDisclosure(
  phase: ReasoningDisclosurePhase,
  event: ReasoningDisclosureEvent,
): ReasoningDisclosurePhase {
  if (event.type === "closed") return phase === "closing" ? "closed" : phase;
  if (phase === "open") return event.animate ? "closing" : "closed";
  // Pressing a closing header reopens it from wherever the fold has reached.
  return "open";
}

/**
 * The line a collapsed, still-thinking row shows: the latest sentence or line
 * the model has finished, with Markdown markers removed. Unfinished text is
 * left out, so the row changes once per finished thought instead of per token.
 */
export function latestReasoningLine(text: string): string {
  let end = lastUnitEnd(text, text.length);
  while (end >= 0) {
    const start = lastUnitEnd(text, end) + 1;
    const line = cleanReasoningLine(text.slice(start, end));
    if (line) return line;
    end = start - 1;
  }
  return "";
}

const SENTENCE_END = new Set([".", "!", "?", "…"]);
const CLOSERS = new Set(['"', "'", ")", "]", "”", "’"]);

/**
 * The index of the whitespace that ends the last finished unit before `before`,
 * or -1. A unit ends at a line break, or at sentence punctuation (and any
 * closing quotes) that whitespace already follows.
 */
function lastUnitEnd(text: string, before: number): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (char === "\n") return index;
    if (!/\s/u.test(char)) continue;
    let mark = index - 1;
    while (mark >= 0 && CLOSERS.has(text[mark]!)) mark -= 1;
    if (mark >= 0 && SENTENCE_END.has(text[mark]!)) return index;
  }
  return -1;
}

function cleanReasoningLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/\*\*|__|`/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
