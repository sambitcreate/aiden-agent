export const STREAMING_REVEAL_HANDOFF_MS = 200;
export const STREAMING_REVEAL_FALLBACK_MS = 2_000;
export const STREAMING_REVEAL_BASE_DELAY_MS = 90;
export const STREAMING_REVEAL_MIN_DELAY_MS = 18;
export const STREAMING_REVEAL_COMPLETE_DELAY_MS = 32;

export type StreamingRevealBlockKind = "prose" | "markdown";

export interface StreamingRevealUnit {
  id: string;
  text: string;
}

export interface StreamingRevealUnitParts {
  leadingWhitespace: string;
  markdown: string;
  trailingWhitespace: string;
}

export interface StreamingRevealBlock {
  id: string;
  kind: StreamingRevealBlockKind;
  units: StreamingRevealUnit[];
}

export interface StreamingRevealScheduleState {
  revealedCount: number;
  dueAt: number | null;
}

export interface StreamingRevealScheduleInput {
  unitCount: number;
  complete: boolean;
  reducedMotion: boolean;
}

interface SourceLine {
  start: number;
  text: string;
  body: string;
  closed: boolean;
}

const COMPLETE_REVEAL_MAX_STEPS = 12;
const PROSE_WORD_GROUP_MIN = 72;
const SENTENCE_ENDERS = new Set([".", "!", "?", "…"]);
const TRAILING_CLOSERS = new Set(['"', "'", ")", "]", "”", "’"]);
const AMBIGUOUS_LINE_START = /^[\s]*[#>\-*+`|=]/u;
const ORDERED_LIST_START = /^[\s]*\d+[.)]?(?:\s|$)/u;
const LIST_LINE = /^[\s]*(?:[-*+]|\d+[.)])\s+/u;
const HEADING_OR_QUOTE = /^[\s]*(?:#{1,6}\s|>|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/u;
const TABLE_SEPARATOR = /^[\s]*\|?[\s:]*-{3,}/u;
const POSSIBLE_TABLE_SEPARATOR = /^[\s]*\|?[\s:|-]*$/u;

/**
 * Markdown parsers trim boundary whitespace when each reveal unit is parsed in
 * isolation. Keep that whitespace as sibling text so adjacent units retain the
 * exact source spacing while their balanced Markdown still renders normally.
 */
export function splitStreamingRevealUnit(text: string): StreamingRevealUnitParts {
  const leadingWhitespace = /^\s+/u.exec(text)?.[0] ?? "";
  if (leadingWhitespace.length === text.length) {
    return { leadingWhitespace, markdown: "", trailingWhitespace: "" };
  }
  const remainder = text.slice(leadingWhitespace.length);
  const trailingWhitespace = /\s+$/u.exec(remainder)?.[0] ?? "";
  return {
    leadingWhitespace,
    markdown: remainder.slice(0, remainder.length - trailingWhitespace.length),
    trailingWhitespace,
  };
}

function sourceLines(text: string, isComplete: boolean): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline >= 0) {
      const value = text.slice(start, newline + 1);
      lines.push({ start, text: value, body: value.slice(0, -1), closed: true });
      start = newline + 1;
      continue;
    }
    const value = text.slice(start);
    lines.push({ start, text: value, body: value, closed: isComplete });
    break;
  }
  return lines;
}

function unambiguousOpenProse(line: string): boolean {
  if (!line.trim()) return false;
  if (AMBIGUOUS_LINE_START.test(line)) return false;
  if (ORDERED_LIST_START.test(line)) {
    const trimmed = line.trimStart();
    const digits = /^\d+/u.exec(trimmed)?.[0] ?? "";
    const rest = trimmed.slice(digits.length);
    if (!rest || rest === "." || rest === ")") return false;
    if (/^[.)]\s/u.test(rest)) return false;
  }
  return true;
}

function stripProtectedInlineMarkdown(value: string): { value: string; balanced: boolean } {
  let candidate = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index]!;
    if (character === "\\") {
      candidate += "  ";
      index += Math.min(2, value.length - index);
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (value[index + runLength] === "`") runLength += 1;
      const marker = "`".repeat(runLength);
      const closing = value.indexOf(marker, index + runLength);
      if (closing < 0) return { value: candidate, balanced: false };
      candidate += " ".repeat(closing + runLength - index);
      index = closing + runLength;
      continue;
    }
    if (character === "$") {
      const runLength = value[index + 1] === "$" ? 2 : 1;
      const marker = "$".repeat(runLength);
      const closing = value.indexOf(marker, index + runLength);
      if (closing >= 0) {
        candidate += " ".repeat(closing + runLength - index);
        index = closing + runLength;
        continue;
      }
      if (runLength === 2) return { value: candidate, balanced: false };
    }
    candidate += character;
    index += 1;
  }
  return { value: candidate, balanced: true };
}

function inlineMarkupBalanced(value: string): boolean {
  const protectedMarkdown = stripProtectedInlineMarkdown(value);
  if (!protectedMarkdown.balanced) return false;
  let candidate = protectedMarkdown.value.replace(/(?<=[\p{L}\p{N}])[*_](?=[\p{L}\p{N}])/gu, "");
  for (const token of ["**", "__", "~~"]) {
    const pieces = candidate.split(token);
    if ((pieces.length - 1) % 2 !== 0) return false;
    candidate = pieces.join("");
  }
  for (const token of ["*", "_"]) {
    if ((candidate.split(token).length - 1) % 2 !== 0) return false;
  }
  if (candidate.split("[").length - 1 !== candidate.split("]").length - 1) return false;
  if (candidate.includes("](")) {
    if (candidate.split("(").length - 1 !== candidate.split(")").length - 1) return false;
  }
  return true;
}

function proseUnits(
  text: string,
  start: number,
  closed: boolean,
  forceFinalRemainder = false,
): StreamingRevealUnit[] {
  const units: StreamingRevealUnit[] = [];
  let currentStart = 0;
  let pendingSentenceEnd = false;

  const emit = (end: number, force = false) => {
    if (end <= currentStart) return;
    const value = text.slice(currentStart, end);
    if (!force && !inlineMarkupBalanced(value)) return;
    units.push({
      id: `prose-${start + currentStart}-${start + end}`,
      text: value,
    });
    currentStart = end;
    pendingSentenceEnd = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\n") {
      emit(index + 1);
      continue;
    }
    if (/\s/u.test(character) && index + 1 - currentStart >= PROSE_WORD_GROUP_MIN) {
      emit(index + 1);
      continue;
    }
    if (/\s/u.test(character) && pendingSentenceEnd) {
      emit(index + 1);
      continue;
    }
    if (SENTENCE_ENDERS.has(character)) {
      pendingSentenceEnd = true;
    } else if (!(pendingSentenceEnd && TRAILING_CLOSERS.has(character))) {
      pendingSentenceEnd = false;
    }
  }

  if (closed && currentStart < text.length) emit(text.length, forceFinalRemainder);
  return units;
}

function atomicMarkdownBlock(start: number, text: string): StreamingRevealBlock {
  return {
    id: `markdown-${start}`,
    kind: "markdown",
    units: [{ id: `markdown-${start}`, text }],
  };
}

function closingFenceIndex(lines: SourceLine[], start: number, marker: string): number {
  const fenceCharacter = marker[0]!;
  for (let index = start; index < lines.length; index += 1) {
    const candidate = lines[index]!.body.trim();
    if (
      candidate.length >= marker.length &&
      candidate.split("").every((character) => character === fenceCharacter)
    ) {
      return index;
    }
  }
  return lines.length;
}

/**
 * Produces a prefix-stable sequence of visual reveal units. Mutable prose is
 * emitted only at irreversible boundaries; ambiguous Markdown starters and
 * unfinished code/table blocks stay withheld until their classification is safe.
 */
export function parseStreamingReveal(text: string, isComplete = false): StreamingRevealBlock[] {
  if (!text) return [];
  const lines = sourceLines(text, isComplete);
  const blocks: StreamingRevealBlock[] = [];
  let paragraphStart = -1;
  let paragraph = "";

  const flushParagraph = (closed: boolean, forceFinalRemainder = false) => {
    if (paragraphStart < 0 || !paragraph.trim()) {
      paragraphStart = -1;
      paragraph = "";
      return;
    }
    const units = proseUnits(paragraph, paragraphStart, closed, forceFinalRemainder);
    if (units.length) {
      blocks.push({
        id: `prose-${paragraphStart}`,
        kind: "prose",
        units,
      });
    }
    paragraphStart = -1;
    paragraph = "";
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.body.trim();

    const openingFence = /^(`{3,}|~{3,})/u.exec(trimmed)?.[1];
    if (openingFence) {
      flushParagraph(true);
      if (!line.closed && !isComplete) break;
      const marker = openingFence;
      const end = closingFenceIndex(lines, index + 1, marker);
      const closedFence = end < lines.length;
      const closingFenceStable = closedFence && (lines[end]!.closed || isComplete);
      const sourceEnd = closingFenceStable ? end + 1 : lines.length;
      let source = lines
        .slice(index, closingFenceStable ? sourceEnd : closedFence ? end : sourceEnd)
        .map((entry) => entry.text)
        .join("");
      if (!closingFenceStable) {
        if (!source.endsWith("\n")) source += "\n";
        source += `${marker}\n`;
      }
      blocks.push(atomicMarkdownBlock(line.start, source));
      index = sourceEnd - 1;
      continue;
    }

    if (!trimmed) {
      flushParagraph(true);
      continue;
    }

    const next = lines[index + 1];
    const firstPipe = line.body.indexOf("|");
    const proseCommittedBeforePipe =
      firstPipe > 0 && proseUnits(line.body.slice(0, firstPipe), line.start, false).length > 0;
    const awaitingTableLookahead =
      trimmed.includes("|") &&
      !proseCommittedBeforePipe &&
      !isComplete &&
      (!next || (!next.closed && POSSIBLE_TABLE_SEPARATOR.test(next.body)));
    if (awaitingTableLookahead) {
      flushParagraph(true);
      break;
    }
    const startsTable =
      trimmed.includes("|") &&
      !proseCommittedBeforePipe &&
      next?.closed === true &&
      TABLE_SEPARATOR.test(next.body) &&
      next.body.includes("|");
    if (startsTable) {
      flushParagraph(true);
      let end = index + 2;
      while (end < lines.length && lines[end]!.body.includes("|") && lines[end]!.body.trim()) {
        end += 1;
      }
      const source = lines
        .slice(index, end)
        .map((entry) => entry.text)
        .join("");
      blocks.push(atomicMarkdownBlock(line.start, source));
      index = end - 1;
      continue;
    }

    if (LIST_LINE.test(line.body)) {
      flushParagraph(true);
      let end = index + 1;
      while (end < lines.length && lines[end]!.body.trim()) end += 1;
      const source = lines
        .slice(index, end)
        .map((entry) => entry.text)
        .join("");
      blocks.push(atomicMarkdownBlock(line.start, source));
      index = end - 1;
      continue;
    }

    if (HEADING_OR_QUOTE.test(line.body)) {
      if (!line.closed) break;
      flushParagraph(true);
      blocks.push(atomicMarkdownBlock(line.start, line.text));
      continue;
    }

    if (!line.closed && !isComplete && !unambiguousOpenProse(line.body)) {
      flushParagraph(true);
      break;
    }

    if (paragraphStart < 0) paragraphStart = line.start;
    paragraph += line.text;
  }

  flushParagraph(isComplete, isComplete);
  return blocks;
}

export function revealDelayMs(pendingUnits: number, isComplete: boolean): number {
  if (isComplete) return STREAMING_REVEAL_COMPLETE_DELAY_MS;
  const accelerated = STREAMING_REVEAL_BASE_DELAY_MS / (1 + Math.max(0, pendingUnits) / 5);
  return Math.max(STREAMING_REVEAL_MIN_DELAY_MS, Math.round(accelerated));
}

/**
 * Advances a completed response through a bounded number of visual waves instead
 * of exposing the full response in the same render that receives `done`.
 */
export function advanceStreamingRevealCount(
  current: number,
  unitCount: number,
  isComplete: boolean,
): number {
  if (current >= unitCount) return unitCount;
  const step = isComplete ? Math.max(1, Math.ceil(unitCount / COMPLETE_REVEAL_MAX_STEPS)) : 1;
  return Math.min(current + step, unitCount);
}

/**
 * Pure scheduler step used by the renderer's persistent animation-frame loop.
 * Growing backlogs retain their original due time instead of starving the timer.
 */
export function advanceStreamingRevealSchedule(
  state: StreamingRevealScheduleState,
  input: StreamingRevealScheduleInput,
  now: number,
): StreamingRevealScheduleState {
  const unitCount = Math.max(0, input.unitCount);
  const revealedCount = Math.min(state.revealedCount, unitCount);
  if (input.reducedMotion) return { revealedCount: unitCount, dueAt: null };
  if (revealedCount >= unitCount) return { revealedCount, dueAt: null };

  const dueAt =
    state.dueAt ??
    (revealedCount === 0 ? now : now + revealDelayMs(unitCount - revealedCount, input.complete));
  if (now < dueAt) return { revealedCount, dueAt };

  const nextCount = advanceStreamingRevealCount(revealedCount, unitCount, input.complete);
  return {
    revealedCount: nextCount,
    dueAt:
      nextCount < unitCount ? now + revealDelayMs(unitCount - nextCount, input.complete) : null,
  };
}

export function streamingRevealHandoffDelay(reduceMotion: boolean): number {
  return reduceMotion ? 0 : STREAMING_REVEAL_HANDOFF_MS;
}
