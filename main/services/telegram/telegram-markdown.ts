// Markdown → Telegram HTML conversion and message chunking.
//
// Telegram supports a restricted HTML subset: <b>, <i>, <code>, <pre>,
// <a href>, <s>, <u>, <blockquote>. This converter handles the common
// Markdown that LLMs emit (headings, bold, italic, inline code, fenced
// code blocks, links, lists) and chunks the result under Telegram's
// 4096-character message limit, respecting code-block boundaries.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT).

/** Telegram message text limit. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_RICH_MESSAGE_LIMIT = 32_768;
export const TELEGRAM_RICH_BLOCK_LIMIT = 500;

/** Safety margin so HTML entity expansion doesn't push past the limit. */
const CHUNK_HEADROOM = 64;

const CODE_SPAN_SENTINEL = String.fromCharCode(0);
const CODE_SPAN_PATTERN = new RegExp(`${CODE_SPAN_SENTINEL}CODESPAN(\\d+)${CODE_SPAN_SENTINEL}`, "g");

interface RichDraftState {
  codeTicks: number;
  comment: boolean;
  displayMath: boolean;
  fence?: { marker: "`" | "~"; length: number };
  strongAsterisk: boolean;
  emphasisAsterisk: boolean;
  strongUnderscore: boolean;
  emphasisUnderscore: boolean;
  strike: boolean;
  linkText: boolean;
  linkDestination: boolean;
}

function richDraftState(): RichDraftState {
  return {
    codeTicks: 0,
    comment: false,
    displayMath: false,
    strongAsterisk: false,
    emphasisAsterisk: false,
    strongUnderscore: false,
    emphasisUnderscore: false,
    strike: false,
    linkText: false,
    linkDestination: false,
  };
}

function richDraftClosed(state: RichDraftState): boolean {
  return state.codeTicks === 0 && !state.comment && !state.displayMath && !state.fence &&
    !state.strongAsterisk && !state.emphasisAsterisk && !state.strongUnderscore &&
    !state.emphasisUnderscore && !state.strike && !state.linkText && !state.linkDestination;
}

function repeated(text: string, index: number, character: string): number {
  let count = 0;
  while (text[index + count] === character) count += 1;
  return count;
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function delimiterCandidate(text: string, index: number, length: number): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + length] ?? "";
  if (!next || /\s/u.test(next)) return Boolean(previous && !/\s/u.test(previous));
  if (!previous || /\s/u.test(previous)) return true;
  return /[\p{P}\p{S}]/u.test(previous) || /[\p{P}\p{S}]/u.test(next);
}

function updateRichDraftLine(line: string, state: RichDraftState): void {
  if (state.fence || state.displayMath) return;
  for (let index = 0; index < line.length; index += 1) {
    if (state.comment) {
      const close = line.indexOf("-->", index);
      if (close === -1) return;
      state.comment = false;
      index = close + 2;
      continue;
    }
    if (state.codeTicks > 0) {
      const ticks = repeated(line, index, "`");
      if (ticks >= state.codeTicks) {
        state.codeTicks = 0;
        index += ticks - 1;
      }
      continue;
    }
    if (escaped(line, index)) continue;
    if (line.startsWith("<!--", index)) {
      const close = line.indexOf("-->", index + 4);
      if (close === -1) {
        state.comment = true;
        return;
      }
      index = close + 2;
      continue;
    }
    const ticks = repeated(line, index, "`");
    if (ticks > 0) {
      state.codeTicks = ticks;
      index += ticks - 1;
      continue;
    }
    if (line.startsWith("][", index) || line.startsWith("](", index)) {
      state.linkText = false;
      state.linkDestination = true;
      index += 1;
      continue;
    }
    if (line[index] === "[" && !state.linkDestination) {
      state.linkText = true;
      continue;
    }
    if (line[index] === ")" && state.linkDestination) {
      state.linkDestination = false;
      continue;
    }
    if (line.startsWith("~~", index) && delimiterCandidate(line, index, 2)) {
      state.strike = !state.strike;
      index += 1;
      continue;
    }
    if (line.startsWith("**", index) && delimiterCandidate(line, index, 2)) {
      state.strongAsterisk = !state.strongAsterisk;
      index += 1;
      continue;
    }
    if (line[index] === "*" && delimiterCandidate(line, index, 1)) {
      state.emphasisAsterisk = !state.emphasisAsterisk;
      continue;
    }
    if (line.startsWith("__", index) && delimiterCandidate(line, index, 2)) {
      state.strongUnderscore = !state.strongUnderscore;
      index += 1;
      continue;
    }
    if (line[index] === "_" && delimiterCandidate(line, index, 1)) {
      state.emphasisUnderscore = !state.emphasisUnderscore;
    }
  }
}

function safeRichDraftEnd(markdown: string): number {
  const state = richDraftState();
  let offset = 0;
  let safeEnd = 0;
  for (const line of markdown.split("\n")) {
    const lineEnd = offset + line.length;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (state.fence) {
      if (new RegExp(`^ {0,3}${state.fence.marker}{${state.fence.length},}\\s*$`, "u").test(line)) state.fence = undefined;
    } else if (state.displayMath) {
      if (line.trim() === "$$") state.displayMath = false;
    } else if (fence) {
      state.fence = { marker: fence[0] as "`" | "~", length: fence.length };
    } else if (line.trim() === "$$") {
      state.displayMath = true;
    } else {
      updateRichDraftLine(line, state);
    }
    if (richDraftClosed(state)) safeEnd = lineEnd;
    offset = lineEnd + 1;
  }
  return richDraftClosed(state) ? markdown.length : safeEnd;
}

/** Return only a structurally closed prefix suitable for sendRichMessageDraft. */
export function safeRichDraftPrefix(markdown: string): string | undefined {
  const source = markdown.trim().slice(0, TELEGRAM_RICH_MESSAGE_LIMIT);
  if (!source) return undefined;
  const safeEnd = safeRichDraftEnd(source);
  const prefix = source.slice(0, safeEnd).trimEnd();
  if (/[\p{L}\p{N}]/u.test(prefix)) return prefix;
  let cursor = source.length;
  while ((cursor = source.lastIndexOf(" ", cursor - 1)) > 0) {
    const candidate = source.slice(0, cursor).trimEnd();
    if (/[\p{L}\p{N}]/u.test(candidate) && safeRichDraftEnd(candidate) === candidate.length) return candidate;
  }
  return undefined;
}

/**
 * Split native Rich Markdown without breaking fenced code blocks or a single
 * top-level inline wrapper. Telegram applies both a character and block limit.
 */
export function chunkRichMarkdown(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/gu, "\n").trim();
  if (!normalized) return [];
  if (richBlockCount(normalized) <= TELEGRAM_RICH_BLOCK_LIMIT && normalized.length <= TELEGRAM_RICH_MESSAGE_LIMIT) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = "";
  let blocks = 0;
  for (const rawBlock of richBlocks(normalized)) {
    for (const block of splitLongRichBlock(rawBlock)) {
      const blockCount = richBlockCount(block);
      const candidate = current ? `${current}\n\n${block}` : block;
      if (candidate.length <= TELEGRAM_RICH_MESSAGE_LIMIT && blocks + blockCount <= TELEGRAM_RICH_BLOCK_LIMIT) {
        current = candidate;
        blocks += blockCount;
        continue;
      }
      if (current) chunks.push(current.trimEnd());
      current = block;
      blocks = blockCount;
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

function richBlocks(markdown: string): string[] {
  const result: string[] = [];
  const current: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const flush = () => {
    if (current.length) result.push(current.splice(0).join("\n"));
  };
  for (const line of markdown.split("\n")) {
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (!fence && !line.trim()) {
      flush();
      continue;
    }
    current.push(line);
    if (!fence && opening) {
      fence = { marker: opening[0]!, length: opening.length };
    } else if (fence && new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u").test(line)) {
      fence = undefined;
    }
  }
  flush();
  return result;
}

function richBlockCount(markdown: string): number {
  return richBlocks(markdown).reduce((total, block) => {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(block)) return total + 1;
    const lines = block.split("\n").filter((line) => line.trim());
    return total + (lines.some((line) => /^\s*(?:[-*+] |\d+\. |> |\|)/u.test(line)) ? Math.max(1, lines.length) : 1);
  }, 0);
}

function splitLongRichBlock(block: string): string[] {
  if (block.length <= TELEGRAM_RICH_MESSAGE_LIMIT && richBlockCount(block) <= TELEGRAM_RICH_BLOCK_LIMIT) return [block];
  const fenced = splitLongFence(block);
  if (fenced) return fenced;
  const wrapper = ["**", "__", "~~", "`", "*", "_"].find(
    (delimiter) => block.startsWith(delimiter) && block.endsWith(delimiter) && block.length > delimiter.length * 2,
  );
  if (wrapper) {
    return splitRichContent(
      block.slice(wrapper.length, -wrapper.length),
      TELEGRAM_RICH_MESSAGE_LIMIT - wrapper.length * 2,
      (value) => `${wrapper}${value}${wrapper}`,
    );
  }
  return splitRichContent(block, TELEGRAM_RICH_MESSAGE_LIMIT, (value) => value.trim());
}

function splitLongFence(block: string): string[] | undefined {
  const lines = block.split("\n");
  const opening = lines[0] ?? "";
  const marker = opening.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
  const closing = lines[lines.length - 1] ?? "";
  if (!marker || !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`, "u").test(closing)) return undefined;
  const limit = TELEGRAM_RICH_MESSAGE_LIMIT - opening.length - closing.length - 2;
  if (limit <= 0) return undefined;
  return splitRichContent(lines.slice(1, -1).join("\n"), limit, (value) => `${opening}\n${value}${value.endsWith("\n") ? "" : "\n"}${closing}`);
}

function splitRichContent(content: string, limit: number, wrap: (value: string) => string): string[] {
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const paragraph = window.lastIndexOf("\n\n", limit);
    const line = window.lastIndexOf("\n", limit);
    const space = window.lastIndexOf(" ", limit);
    const splitAt = paragraph > 0 ? paragraph + 2 : line > 0 ? line + 1 : space > 0 ? space + 1 : limit;
    chunks.push(wrap(remaining.slice(0, splitAt)));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(wrap(remaining));
  return chunks;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a URL for safe placement inside an HTML attribute value. */
function escapeHref(url: string): string {
  return url.replace(/"/g, "&quot;");
}

/** Convert inline Markdown to Telegram HTML (no block-level handling). */
function convertInline(markdown: string): string {
  // Protect fenced code spans first so their content is not reformatted.
  const codeSpans: string[] = [];
  let working = markdown.replace(/```[\s\S]*?```/g, (match) => {
    codeSpans.push(match);
    return `${CODE_SPAN_SENTINEL}CODESPAN${codeSpans.length - 1}${CODE_SPAN_SENTINEL}`;
  });

  // Inline code: `code`
  working = working.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_SPAN_SENTINEL}CODESPAN${codeSpans.length - 1}${CODE_SPAN_SENTINEL}`;
  });

  // Escape remaining HTML.
  working = escapeHtml(working);

  // Bold: **text** or __text__
  working = working.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  working = working.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_
  working = working.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  working = working.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  working = working.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) — escape quotes in the URL for safe attribute injection.
  working = working.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, url: string) =>
      `<a href="${escapeHref(url)}">${text}</a>`,
  );

  // Restore code spans.
  working = working.replace(CODE_SPAN_PATTERN, (_m, idx: string) => {
    const i = Number(idx);
    if (i < codeSpans.length && codeSpans[i].startsWith("```")) {
      return convertFencedBlock(codeSpans[i]);
    }
    return codeSpans[i] ?? "";
  });

  return working;
}

function convertFencedBlock(raw: string): string {
  const match = /^```(\w*)\n?([\s\S]*?)```$/.exec(raw);
  const lang = match?.[1];
  const code = match?.[2] ?? raw.slice(3, -3);
  const escaped = escapeHtml(code.replace(/\n$/, ""));
  return lang ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`;
}

/**
 * Convert a Markdown string to Telegram HTML.
 * Handles headings, fenced code blocks, inline formatting, links, lists, and blockquotes.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];

  let inFencedBlock = false;
  let fenceMarker = "";
  let codeLines: string[] = [];

  for (const line of lines) {
    // Detect fenced code block boundaries.
    const fenceMatch = /^(`{3,})(\w*)/.exec(line);
    if (fenceMatch && !inFencedBlock) {
      inFencedBlock = true;
      fenceMarker = fenceMatch[1];
      codeLines = [line];
      continue;
    }
    if (inFencedBlock) {
      codeLines.push(line);
      // Closing fence: backticks-only line, at least as long as the opening.
      const trimmed = line.trim();
      if (trimmed.length >= fenceMarker.length && /^`+$/.test(trimmed)) {
        inFencedBlock = false;
        output.push(convertFencedBlock(codeLines.join("\n")));
      }
      continue;
    }

    // Headings → bold.
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      output.push(`<b>${convertInline(headingMatch[2])}</b>`);
      continue;
    }

    // Blockquote.
    if (line.startsWith("> ")) {
      output.push(`<blockquote>${convertInline(line.slice(2))}</blockquote>`);
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push("\n\u2500\u2500\u2500\u2500\u2500\n");
      continue;
    }

    // Blank line — preserve as paragraph break.
    if (line.trim() === "") {
      output.push("");
      continue;
    }

    // Everything else: inline conversion.
    output.push(convertInline(line));
  }

  // Unclosed fenced block: emit raw.
  if (inFencedBlock) output.push(convertFencedBlock(codeLines.join("\n")));

  return output.join("\n").trim();
}

/**
 * Split HTML text into chunks under the Telegram message limit.
 * Prefers splitting at double-newline boundaries (paragraph breaks);
 * falls back to hard splits if a single paragraph exceeds the limit.
 * Tracks <pre> state across chunk boundaries so tags stay balanced.
 */
export function chunkForTelegram(html: string): string[] {
  const limit = TELEGRAM_MESSAGE_LIMIT - CHUNK_HEADROOM;
  if (html.length <= limit) return html.length > 0 ? [html] : [];

  const chunks: string[] = [];
  const paragraphs = html.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (para.length > limit) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      for (const piece of hardSplit(para, limit)) chunks.push(piece);
      continue;
    }

    if ((current + "\n\n" + para).length > limit) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.map(balancePreTags);
}

/**
 * Ensure each chunk has balanced <pre> tags. If a chunk opens <pre>
 * without closing it, append </pre>; if it closes </pre> without
 * opening one, prepend <pre>.
 */
function balancePreTags(chunk: string): string {
  const opens = (chunk.match(/<pre[^>]*>/g) ?? []).length;
  const closes = (chunk.match(/<\/pre>/g) ?? []).length;
  if (opens === closes) return chunk;
  if (opens > closes) return chunk + "\n</pre>".repeat(opens - closes);
  return "<pre>".repeat(closes - opens) + chunk;
}

/** Hard-split a long block at newline boundaries, then by char count. */
function hardSplit(text: string, limit: number): string[] {
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > limit) {
      if (current) chunks.push(current.trim());
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          chunks.push(line.slice(i, i + limit));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
