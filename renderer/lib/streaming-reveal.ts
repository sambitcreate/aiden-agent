export const STREAMING_REVEAL_HANDOFF_MS = 260;
export const STREAMING_REVEAL_BASE_DELAY_MS = 90;
export const STREAMING_REVEAL_MIN_DELAY_MS = 18;

export type StreamingRevealBlockKind = "prose" | "markdown" | "list" | "code" | "table";

export interface StreamingRevealUnit {
  id: string;
  text: string;
}

export interface StreamingRevealBlock {
  id: string;
  kind: StreamingRevealBlockKind;
  units: StreamingRevealUnit[];
  language?: string;
  ordered?: boolean;
}

interface SourceLine {
  start: number;
  text: string;
  body: string;
  closed: boolean;
}

const PROSE_SOFT_MIN = 48;
const PROSE_HARD_MAX = 180;
const SENTENCE_ENDERS = new Set([".", "!", "?", "…"]);
const TRAILING_CLOSERS = new Set(['"', "'", ")", "]", "”", "’"]);
const AMBIGUOUS_LINE_START = /^[\s]*[#>\-*+`|=]/u;
const ORDERED_LIST_START = /^[\s]*\d+[.)]?(?:\s|$)/u;
const LIST_LINE = /^[\s]*(?:[-*+]|\d+[.)])\s+/u;
const HEADING_OR_QUOTE = /^[\s]*(?:#{1,6}\s|>|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/u;
const TABLE_SEPARATOR = /^[\s]*\|?[\s:]*-{3,}/u;
const POSSIBLE_TABLE_SEPARATOR = /^[\s]*\|?[\s:|-]*$/u;

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

function proseUnits(text: string, start: number, closed: boolean): StreamingRevealUnit[] {
  const units: StreamingRevealUnit[] = [];
  let currentStart = 0;
  let pendingSentenceEnd = false;

  const inlineMarkupBalanced = (value: string) => {
    let candidate = value.replace(/\\./gu, "");
    for (const token of ["**", "__", "~~", "`", "$"]) {
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
  };

  const emit = (end: number) => {
    if (end <= currentStart) return;
    const value = text.slice(currentStart, end);
    if (!inlineMarkupBalanced(value)) return;
    units.push({
      id: `prose-${start + currentStart}-${start + end}`,
      text: value,
    });
    currentStart = end;
    pendingSentenceEnd = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const length = index + 1 - currentStart;
    if (character === "\n") {
      emit(index + 1);
      continue;
    }
    if (/\s/u.test(character) && pendingSentenceEnd && length >= PROSE_SOFT_MIN) {
      emit(index + 1);
      continue;
    }
    if (SENTENCE_ENDERS.has(character)) {
      pendingSentenceEnd = true;
    } else if (!(pendingSentenceEnd && TRAILING_CLOSERS.has(character))) {
      pendingSentenceEnd = false;
    }
    if (length >= PROSE_HARD_MAX && /\s/u.test(character)) emit(index + 1);
  }

  if (closed && currentStart < text.length) emit(text.length);
  return units;
}

function atomicBlock(
  kind: Exclude<StreamingRevealBlockKind, "prose">,
  start: number,
  text: string,
): StreamingRevealBlock {
  return {
    id: `${kind}-${start}`,
    kind,
    units: [{ id: `${kind}-${start}-${start + text.length}`, text }],
  };
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

  const flushParagraph = (closed: boolean) => {
    if (paragraphStart < 0 || !paragraph.trim()) {
      paragraphStart = -1;
      paragraph = "";
      return;
    }
    const units = proseUnits(paragraph, paragraphStart, closed);
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

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      flushParagraph(true);
      if (!line.closed && !isComplete) break;
      const marker = trimmed.slice(0, 3);
      let end = index + 1;
      while (end < lines.length && !lines[end]!.body.trim().startsWith(marker)) end += 1;
      const closedFence = end < lines.length;
      const contentEnd = closedFence ? end : lines.length;
      const contentLines = lines
        .slice(index + 1, contentEnd)
        .filter((entry) => entry.closed || isComplete);
      const units: StreamingRevealUnit[] = [];
      const lineGroupSize = 4;
      const completeGroupCount =
        closedFence || isComplete
          ? Math.ceil(contentLines.length / lineGroupSize)
          : Math.floor(contentLines.length / lineGroupSize);
      for (let group = 0; group < completeGroupCount; group += 1) {
        const entries = contentLines.slice(group * lineGroupSize, (group + 1) * lineGroupSize);
        if (!entries.length) continue;
        const groupStart = entries[0]!.start;
        const groupEnd =
          entries[entries.length - 1]!.start + entries[entries.length - 1]!.text.length;
        units.push({
          id: `code-${groupStart}-${groupEnd}`,
          text: entries.map((entry) => entry.text).join(""),
        });
      }
      if (units.length) {
        blocks.push({
          id: `code-${line.start}`,
          kind: "code",
          language: trimmed.slice(3).trim() || undefined,
          units,
        });
      }
      index = closedFence ? end : lines.length - 1;
      continue;
    }

    if (!trimmed) {
      flushParagraph(true);
      continue;
    }

    const next = lines[index + 1];
    const awaitingTableLookahead =
      trimmed.includes("|") &&
      !isComplete &&
      (!next || (!next.closed && POSSIBLE_TABLE_SEPARATOR.test(next.body)));
    if (awaitingTableLookahead) {
      flushParagraph(true);
      break;
    }
    const startsTable =
      trimmed.includes("|") &&
      next?.closed === true &&
      TABLE_SEPARATOR.test(next.body) &&
      next.body.includes("|");
    if (startsTable) {
      flushParagraph(true);
      let end = index + 2;
      while (end < lines.length && lines[end]!.body.includes("|") && lines[end]!.body.trim()) {
        end += 1;
      }
      const tableClosed = end < lines.length || isComplete;
      if (!tableClosed) break;
      const source = lines
        .slice(index, end)
        .map((entry) => entry.text)
        .join("");
      blocks.push(atomicBlock("table", line.start, source));
      index = end - 1;
      continue;
    }

    if (LIST_LINE.test(line.body)) {
      flushParagraph(true);
      let end = index;
      while (end < lines.length && LIST_LINE.test(lines[end]!.body)) end += 1;
      const entries = lines.slice(index, end);
      const visibleEntries = entries.filter((entry) => entry.closed || isComplete);
      if (!visibleEntries.length) break;
      const ordered = /^[\s]*\d+[.)]\s+/u.test(line.body);
      blocks.push({
        id: `list-${line.start}`,
        kind: "list",
        ordered,
        units: visibleEntries.map((entry) => ({
          id: `list-${entry.start}-${entry.start + entry.text.length}`,
          text: entry.body.replace(LIST_LINE, ""),
        })),
      });
      index = end - 1;
      continue;
    }

    if (HEADING_OR_QUOTE.test(line.body)) {
      if (!line.closed) break;
      flushParagraph(true);
      blocks.push(atomicBlock("markdown", line.start, line.text));
      continue;
    }

    if (!line.closed && !isComplete && !unambiguousOpenProse(line.body)) {
      flushParagraph(true);
      break;
    }

    if (paragraphStart < 0) paragraphStart = line.start;
    paragraph += line.text;
  }

  flushParagraph(isComplete);
  return blocks;
}

export function revealDelayMs(pendingUnits: number, isComplete: boolean): number {
  if (isComplete) return STREAMING_REVEAL_MIN_DELAY_MS;
  const accelerated = STREAMING_REVEAL_BASE_DELAY_MS / (1 + Math.max(0, pendingUnits) / 5);
  return Math.max(STREAMING_REVEAL_MIN_DELAY_MS, Math.round(accelerated));
}

export function streamingRevealHandoffDelay(reduceMotion: boolean): number {
  return reduceMotion ? 0 : STREAMING_REVEAL_HANDOFF_MS;
}
