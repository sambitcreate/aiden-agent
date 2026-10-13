export const STREAMING_REVEAL_HANDOFF_MS = 200;
export const STREAMING_REVEAL_FALLBACK_MS = 2_000;
/** How long newly released text takes to fade in (matches styles.css). */
export const STREAMING_REVEAL_FADE_MS = 450;

export type StreamingRevealBlockKind = "prose" | "markdown";

export interface StreamingRevealUnit {
  id: string;
  text: string;
  /** Where this unit's source ends in the response. */
  end: number;
  /**
   * Set only while a fenced code block is still open. Its source grows every
   * line, so it renders as plain monospaced text and is highlighted once the
   * closing fence (or the end of the turn) settles it.
   */
  openCode?: { code: string; lang?: string };
  /**
   * Set once a top-level fence has closed. The block keeps rendering through
   * the same code component, which gains highlighting in place.
   */
  fence?: { code: string; lang?: string };
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

interface SourceLine {
  start: number;
  text: string;
  body: string;
  closed: boolean;
}

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

function sourceLines(text: string, isComplete: boolean, baseOffset = 0): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline >= 0) {
      const value = text.slice(start, newline + 1);
      lines.push({ start: baseOffset + start, text: value, body: value.slice(0, -1), closed: true });
      start = newline + 1;
      continue;
    }
    const value = text.slice(start);
    lines.push({ start: baseOffset + start, text: value, body: value, closed: isComplete });
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
      end: start + end,
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

function atomicMarkdownBlock(
  lines: SourceLine[],
  text: string,
  code?: Pick<StreamingRevealUnit, "openCode" | "fence">,
): StreamingRevealBlock {
  const start = lines[0]!.start;
  const last = lines[lines.length - 1]!;
  return {
    id: `markdown-${start}`,
    kind: "markdown",
    units: [{ id: `markdown-${start}`, text, end: last.start + last.text.length, ...code }],
  };
}

/** The language CodeBlock would read from the fence's info string. */
function fenceLanguage(info: string): string | undefined {
  return /^\w+/u.exec(info.trim().split(/\s/u)[0] ?? "")?.[0];
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
  return parseStreamingRevealRange(text, isComplete, 0).blocks;
}

interface StreamingRevealRange {
  blocks: StreamingRevealBlock[];
  /** Characters of `text` before the last top-level blank line's end. */
  stableLength: number;
  /** Blocks wholly before `stableLength`; later text cannot change them. */
  stableBlockCount: number;
}

/**
 * Parse `text`, whose first character sits at `baseOffset` in the response.
 * A closed blank line at the top level resets every piece of parser state and
 * no earlier line looks past it, so blocks before it are final.
 */
function parseStreamingRevealRange(
  text: string,
  isComplete: boolean,
  baseOffset: number,
): StreamingRevealRange {
  if (!text) return { blocks: [], stableLength: 0, stableBlockCount: 0 };
  const lines = sourceLines(text, isComplete, baseOffset);
  const blocks: StreamingRevealBlock[] = [];
  let stableLength = 0;
  let stableBlockCount = 0;
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
      const sourceLinesShown = lines.slice(
        index,
        closingFenceStable ? sourceEnd : closedFence ? end : sourceEnd,
      );
      let source = sourceLinesShown.map((entry) => entry.text).join("");
      let code: Pick<StreamingRevealUnit, "openCode" | "fence"> | undefined;
      if (!closingFenceStable) {
        if (!source.endsWith("\n")) source += "\n";
        source += `${marker}\n`;
      }
      // An indented fence strips its indent from the code lines; leave that
      // rare shape to the Markdown renderer rather than re-implementing it.
      if (line.body.startsWith(marker)) {
        const body = lines
          .slice(index + 1, closedFence ? end : sourceEnd)
          .map((entry) => entry.text)
          .join("");
        const lang = fenceLanguage(trimmed.slice(marker.length));
        const fence = lang ? { code: body, lang } : { code: body };
        code = closingFenceStable ? { fence } : { openCode: fence };
      }
      blocks.push(atomicMarkdownBlock(sourceLinesShown, source, code));
      index = sourceEnd - 1;
      continue;
    }

    if (!trimmed) {
      flushParagraph(true);
      if (line.closed) {
        stableLength = line.start - baseOffset + line.text.length;
        stableBlockCount = blocks.length;
      }
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
      const tableLines = lines.slice(index, end);
      blocks.push(atomicMarkdownBlock(tableLines, tableLines.map((entry) => entry.text).join("")));
      index = end - 1;
      continue;
    }

    if (LIST_LINE.test(line.body)) {
      flushParagraph(true);
      let end = index + 1;
      while (end < lines.length && lines[end]!.body.trim()) end += 1;
      const listLines = lines.slice(index, end);
      blocks.push(atomicMarkdownBlock(listLines, listLines.map((entry) => entry.text).join("")));
      index = end - 1;
      continue;
    }

    if (HEADING_OR_QUOTE.test(line.body)) {
      if (!line.closed) break;
      flushParagraph(true);
      blocks.push(atomicMarkdownBlock([line], line.text));
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
  return { blocks, stableLength, stableBlockCount };
}

/**
 * Incremental `parseStreamingReveal` for an append-only stream: blocks before
 * the last top-level blank line are kept, and only the text after it is
 * reparsed, so each delta costs the open tail instead of the whole response.
 * Any non-append change (reset, retry) falls back to a full parse.
 */
export class StreamingRevealParser {
  private stablePrefix = "";
  private stableBlocks: StreamingRevealBlock[] = [];

  parse(text: string, isComplete = false): StreamingRevealBlock[] {
    if (!text.startsWith(this.stablePrefix)) {
      this.stablePrefix = "";
      this.stableBlocks = [];
    }
    const base = this.stablePrefix.length;
    const tail = parseStreamingRevealRange(text.slice(base), isComplete, base);
    const blocks = this.stableBlocks.length ? this.stableBlocks.concat(tail.blocks) : tail.blocks;
    if (tail.stableLength > 0) {
      this.stablePrefix = text.slice(0, base + tail.stableLength);
      this.stableBlocks = blocks.slice(0, this.stableBlocks.length + tail.stableBlockCount);
    }
    return blocks;
  }
}

/**
 * Where the first `count` reveal units end in the response. Units follow the
 * source in order, so the text before this offset is exactly what has been
 * revealed, and it renders as one Markdown document.
 */
export function streamingRevealVisibleEnd(blocks: StreamingRevealBlock[], count: number): number {
  let remaining = count;
  let end = 0;
  for (const block of blocks) {
    for (const unit of block.units) {
      if (remaining <= 0) return end;
      end = unit.end;
      remaining -= 1;
    }
  }
  return end;
}

/** The shortest gap between two releases of new text into the transcript. */
export const STREAMING_REVEAL_RELEASE_MS = 300;
/**
 * The longest a pending tail with no paragraph, item, row, or code-line
 * boundary waits: a lone heading, the last list item, or the sentences of a
 * paragraph still being written.
 */
export const STREAMING_REVEAL_MAX_WAIT_MS = 1_000;

const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/u;
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/u;

function closesFence(line: string, marker: string): boolean {
  const candidate = line.trim();
  return (
    candidate.length >= marker.length &&
    [...candidate].every((character) => character === marker[0])
  );
}

/**
 * Where a boundary scan stopped: the finished lines of `text` it has read and
 * the fence and table state at the end of them. Resuming from it reads only
 * the lines that arrived since.
 */
export interface StreamingRevealBoundaryScan {
  /** The scanned prefix of the text, ending after its last finished line. */
  text: string;
  boundary: number;
  fence: string | null;
  previous: string;
  previousTableRow: boolean;
  tableHeader: boolean;
}

export const INITIAL_STREAMING_REVEAL_BOUNDARY_SCAN: StreamingRevealBoundaryScan = {
  text: "",
  boundary: 0,
  fence: null,
  previous: "",
  previousTableRow: false,
  tableHeader: false,
};

/**
 * Continues `scan` over the lines of `text` that finished since it stopped, or
 * starts over when `text` does not extend what it read. `boundary` is the
 * same as `lastStreamingRevealBoundary(text)`.
 */
export function scanStreamingRevealBoundary(
  scan: StreamingRevealBoundaryScan,
  text: string,
): { scan: StreamingRevealBoundaryScan; boundary: number } {
  const start = text.startsWith(scan.text) ? scan : INITIAL_STREAMING_REVEAL_BOUNDARY_SCAN;
  let { boundary, fence, previous, previousTableRow, tableHeader } = start;
  let offset = start.text.length;
  for (let newline = text.indexOf("\n", offset); newline >= 0; newline = text.indexOf("\n", offset)) {
    const line = text.slice(offset, newline);
    const end = newline + 1;
    const trimmed = line.trim();
    if (fence) {
      // Every finished code line grows the open block; the closing fence ends it.
      if (closesFence(line, fence)) fence = null;
      boundary = end;
      previous = trimmed;
    } else if (FENCE_OPENER.test(line)) {
      // The opener waits for its first line of code.
      fence = FENCE_OPENER.exec(line)![1]!;
      previous = trimmed;
    } else if (!trimmed) {
      if (previous && !HEADING_LINE.test(previous)) boundary = end;
      previousTableRow = false;
      tableHeader = false;
    } else {
      // Each item joins once the next one starts.
      if (LIST_LINE.test(line) && previous && !HEADING_LINE.test(previous)) boundary = offset;
      const tableRow = trimmed.includes("|");
      // A table joins with its first body row, then grows a row at a time.
      if (tableRow && previousTableRow && tableHeader) boundary = end;
      if (tableRow && previousTableRow && TABLE_SEPARATOR.test(line)) tableHeader = true;
      if (!tableRow) tableHeader = false;
      previousTableRow = tableRow;
      previous = trimmed;
    }
    offset = end;
  }
  const next: StreamingRevealBoundaryScan =
    offset === start.text.length
      ? start
      : { text: text.slice(0, offset), boundary, fence, previous, previousTableRow, tableHeader };
  // The next item's first word is enough to know the previous item ended.
  const partial = text.slice(offset);
  const nextItem = !fence && /^[\s]*(?:[-*+]|\d+[.)])\s+[^\s*_-]/u.test(partial);
  return {
    scan: next,
    boundary: nextItem && previous && !HEADING_LINE.test(previous) ? offset : boundary,
  };
}

/**
 * The end of the last place in `text` where a whole block has arrived: a
 * paragraph's closing blank line (a heading waits for its first paragraph),
 * the start of the next list item, the end of a table row, or a finished line
 * of code. Apart from a new item's first word, only whole lines decide.
 */
export function lastStreamingRevealBoundary(text: string): number {
  return scanStreamingRevealBoundary(INITIAL_STREAMING_REVEAL_BOUNDARY_SCAN, text).boundary;
}

export interface StreamingRevealGate {
  /** The released prefix; the parser sees only this. */
  text: string;
  releasedAt: number | null;
  /** When the oldest unreleased text arrived, or null when nothing waits. */
  waitingSince: number | null;
  /** Where the boundary scan stopped, so the next release reads only new lines. */
  scan: StreamingRevealBoundaryScan;
}

export interface StreamingRevealGateInput {
  content: string;
  /** The turn ended: everything shows now and the reply hands over. */
  complete: boolean;
  /**
   * The text can no longer grow because a tool step closed it. Its end counts
   * as a boundary, so the rest joins at the next release rather than at once.
   */
  closed?: boolean;
  reducedMotion: boolean;
}

export const INITIAL_STREAMING_REVEAL_GATE: StreamingRevealGate = {
  text: "",
  releasedAt: null,
  waitingSince: null,
  scan: INITIAL_STREAMING_REVEAL_BOUNDARY_SCAN,
};

/**
 * One step of the release gate. New text joins the transcript only at whole
 * block boundaries and at most once per `STREAMING_REVEAL_RELEASE_MS`; a tail
 * without a boundary is released after `STREAMING_REVEAL_MAX_WAIT_MS`. The end
 * of the turn and reduced motion release everything at once. `nextAt` is when
 * calling again can release more, or null when nothing is waiting. Boundaries
 * are only looked for once a release is allowed, and the scan resumes where
 * the last one stopped.
 */
export function advanceStreamingRevealGate(
  gate: StreamingRevealGate,
  { content, complete, closed = false, reducedMotion }: StreamingRevealGateInput,
  now: number,
): { gate: StreamingRevealGate; nextAt: number | null } {
  const current = content.startsWith(gate.text)
    ? gate
    : { ...INITIAL_STREAMING_REVEAL_GATE, scan: gate.scan };
  const released = current.text.length;
  if (released === content.length) {
    const settled = current.waitingSince === null ? current : { ...current, waitingSince: null };
    return { gate: settled, nextAt: null };
  }
  if (complete || reducedMotion) {
    return {
      gate: { ...current, text: content, releasedAt: now, waitingSince: null },
      nextAt: null,
    };
  }
  const waitingSince = current.waitingSince ?? now;
  const earliest =
    current.releasedAt === null ? now : current.releasedAt + STREAMING_REVEAL_RELEASE_MS;
  if (now < earliest) {
    const waiting = waitingSince === current.waitingSince ? current : { ...current, waitingSince };
    return { gate: waiting, nextAt: earliest };
  }
  const { scan, boundary: found } = closed
    ? { scan: current.scan, boundary: content.length }
    : scanStreamingRevealBoundary(current.scan, content);
  const due = waitingSince + STREAMING_REVEAL_MAX_WAIT_MS;
  const boundary = found > released ? found : now >= due ? content.length : released;
  if (boundary === released) {
    return { gate: { ...current, waitingSince, scan }, nextAt: Math.max(earliest, due) };
  }
  const tail = boundary < content.length ? now : null;
  return {
    gate: { text: content.slice(0, boundary), releasedAt: now, waitingSince: tail, scan },
    nextAt: tail === null ? null : now + STREAMING_REVEAL_MAX_WAIT_MS,
  };
}

export function streamingRevealHandoffDelay(reduceMotion: boolean): number {
  return reduceMotion ? 0 : STREAMING_REVEAL_HANDOFF_MS;
}
