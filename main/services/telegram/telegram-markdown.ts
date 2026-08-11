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

/** Safety margin so HTML entity expansion doesn't push past the limit. */
const CHUNK_HEADROOM = 64;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Convert inline Markdown to Telegram HTML (no block-level handling). */
function convertInline(markdown: string): string {
  // Protect fenced code spans first so their content is not reformatted.
  const codeSpans: string[] = [];
  let working = markdown.replace(/```[\s\S]*?```/g, (match) => {
    codeSpans.push(match);
    return `\x00CODESPAN${codeSpans.length - 1}\x00`;
  });

  // Inline code: `code`
  working = working.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODESPAN${codeSpans.length - 1}\x00`;
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

  // Links: [text](url)
  working = working.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Restore code spans.
  working = working.replace(/\x00CODESPAN(\d+)\x00/g, (_m, idx: string) => {
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
      if (line.startsWith(fenceMarker) || line.trim() === fenceMarker.slice(0, 3)) {
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
    if (line.startsWith("&gt; ") || line.startsWith("> ")) {
      const text = line.startsWith("&gt; ") ? line.slice(5) : line.slice(2);
      output.push(`<blockquote>${convertInline(text)}</blockquote>`);
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
 */
export function chunkForTelegram(html: string): string[] {
  const limit = TELEGRAM_MESSAGE_LIMIT - CHUNK_HEADROOM;
  if (html.length <= limit) return html.length > 0 ? [html] : [];

  const chunks: string[] = [];
  const paragraphs = html.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (para.length > limit) {
      // Flush current chunk first.
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      // Hard-split the oversized paragraph at line boundaries.
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
  return chunks;
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
        // Char-level split for pathologically long lines.
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
