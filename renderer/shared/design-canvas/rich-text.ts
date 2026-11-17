// The words in a note or a text item: a small Markdown subset, so Aiden reads
// and writes them as plain text and nothing in them can run.
//
//   **bold**  *italic*  <u>underline</u>  [a link](https://…)
//   - a bullet        1. a numbered item
//
// Each line is its own paragraph. Links keep only http, https and mailto
// addresses; anything else stays as its words. Pure and shared: the canvas
// draws from it and main's canvas tools describe it.

export type RichMarks = { bold?: true; italic?: true; underline?: true; href?: string };
export type RichSpan = { text: string; marks: RichMarks };
export type RichLine = RichSpan[];
export type RichBlock =
  | { type: "paragraph"; spans: RichLine }
  | { type: "bullets"; items: RichLine[] }
  | { type: "numbers"; items: RichLine[] };

const BULLET = /^[-*] (.*)$/;
const NUMBER = /^\d{1,3}[.)] (.*)$/;

/** An address a link may keep: http, https or mailto, and nothing that could run. */
export function safeLinkHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href;
  } catch {
    // Not an address.
  }
  return null;
}

/** An address a person typed, with https:// added when it has no scheme. */
export function linkFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return safeLinkHref(trimmed);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return safeLinkHref(`mailto:${trimmed}`);
  return safeLinkHref(`https://${trimmed}`);
}

const sameMarks = (a: RichMarks, b: RichMarks) =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.href === b.href;

function pushSpan(line: RichLine, text: string, marks: RichMarks) {
  if (!text) return;
  const last = line[line.length - 1];
  if (last && sameMarks(last.marks, marks)) last.text += text;
  else line.push({ text, marks: { ...marks } });
}

/** One line of Markdown as runs of text that share their marks. */
export function parseInline(source: string): RichLine {
  const line: RichLine = [];
  const walk = (text: string, marks: RichMarks) => {
    let plain = "";
    const flush = () => {
      pushSpan(line, plain, marks);
      plain = "";
    };
    let index = 0;
    while (index < text.length) {
      const rest = text.slice(index);
      const char = text[index]!;
      if (char === "\\" && index + 1 < text.length && /[\\*_[\]()<>`]/.test(text[index + 1]!)) {
        plain += text[index + 1];
        index += 2;
        continue;
      }
      if (rest.startsWith("**")) {
        const close = findClose(text, index + 2, "**");
        if (close > index + 2) {
          flush();
          walk(text.slice(index + 2, close), { ...marks, bold: true });
          index = close + 2;
          continue;
        }
      }
      // `_` opens italics only at the start of a word, so snake_case stays as it is.
      const wordStart = char === "*" || index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]!);
      if ((char === "*" || char === "_") && wordStart && !rest.startsWith("**")) {
        const close = findClose(text, index + 1, char);
        if (close > index + 1 && text[index + 1] !== " ") {
          flush();
          walk(text.slice(index + 1, close), { ...marks, italic: true });
          index = close + 1;
          continue;
        }
      }
      if (rest.startsWith("<u>")) {
        const close = text.indexOf("</u>", index + 3);
        if (close > index + 3) {
          flush();
          walk(text.slice(index + 3, close), { ...marks, underline: true });
          index = close + 4;
          continue;
        }
      }
      if (char === "[" && marks.href === undefined) {
        const link = /^\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/.exec(rest);
        if (link) {
          flush();
          const href = safeLinkHref(link[2]!);
          walk(link[1]!, href ? { ...marks, href } : marks);
          index += link[0].length;
          continue;
        }
      }
      plain += char;
      index += 1;
    }
    flush();
  };
  walk(source, {});
  return line;
}

/** Where `marker` closes a run that opened before `from`, skipping escaped characters. */
function findClose(text: string, from: number, marker: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text.startsWith(marker, index)) {
      // A pair of stars inside an italic run opens a bold run, not the close;
      // one or three or more stars close it at the first.
      let run = 1;
      while (text[index + run] === marker) run += 1;
      if (marker.length === 1 && run === 2) {
        const inner = findClose(text, index + 2, marker + marker);
        if (inner !== -1) {
          index = inner + 1;
          continue;
        }
      }
      if (marker !== "**") return index;
      // In a run of stars, bold closes where the stars it holds pair up, so
      // `***x***` is bold around italic and `**a*b****c*` is bold, then italic.
      let last = index;
      while (text[last + 2] === "*") last += 1;
      for (let close = index; close <= last; close += 1) {
        if (unescapedStars(text.slice(from, close)) % 2 === 0) return close;
      }
      return index;
    }
  }
  return -1;
}

function unescapedStars(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "*") count += 1;
  }
  return count;
}

/** A note's or text item's Markdown as paragraphs and lists. */
export function parseRichText(source: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET.exec(raw);
    const number = bullet ? null : NUMBER.exec(raw);
    const type = bullet ? "bullets" : number ? "numbers" : "paragraph";
    if (type === "paragraph") {
      blocks.push({ type, spans: parseInline(raw) });
      continue;
    }
    const item = parseInline((bullet ?? number)![1]!);
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.items.push(item);
    else blocks.push({ type, items: [item] } as RichBlock);
  }
  return blocks;
}

const escapeText = (text: string) =>
  text.replace(/[\\*_[\]<>`]/g, (char) => `\\${char}`).replace(/^(\d{1,3})([.)] )/, "$1\\$2").replace(/^([-*]) /, "\\$1 ");

function serializeLine(line: RichLine): string {
  let out = "";
  let index = 0;
  // Spans that share a link are written inside one [ ](…).
  while (index < line.length) {
    const href = line[index]!.marks.href;
    if (href) {
      let end = index;
      while (end < line.length && line[end]!.marks.href === href) end += 1;
      const inner = line.slice(index, end).map((span) => ({ text: span.text, marks: { ...span.marks, href: undefined } }));
      out += `[${serializeMarks(inner)}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
      index = end;
    } else {
      let end = index;
      while (end < line.length && !line[end]!.marks.href) end += 1;
      out += serializeMarks(line.slice(index, end));
      index = end;
    }
  }
  return out;
}

const MARK_WRAPS = [
  ["bold", "**", "**"],
  ["italic", "*", "*"],
  ["underline", "<u>", "</u>"],
] as const;

/**
 * Runs that share a mark are wrapped once, outermost bold, then italic, then
 * underline, so `**ab*cd***` comes out rather than markers that run together.
 */
function serializeMarks(spans: readonly RichSpan[], level = 0): string {
  const wrap = MARK_WRAPS[level];
  if (!wrap) return spans.map((span) => escapeText(span.text)).join("");
  const [key, open, close] = wrap;
  let out = "";
  let index = 0;
  while (index < spans.length) {
    const on = spans[index]!.marks[key] === true;
    let end = index;
    while (end < spans.length && (spans[end]!.marks[key] === true) === on) end += 1;
    const inner = serializeMarks(spans.slice(index, end), level + 1);
    if (!on) out += inner;
    else {
      // Marks wrap the words, not the spaces around them, so `** x**` never appears.
      const lead = /^\s*/.exec(inner)![0];
      const trail = /\s*$/.exec(inner.slice(lead.length))![0];
      const core = inner.slice(lead.length, inner.length - trail.length);
      out += core ? `${lead}${open}${core}${close}${trail}` : inner;
    }
    index = end;
  }
  return out;
}

/** Paragraphs and lists back as Markdown. */
export function serializeRichText(blocks: readonly RichBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") lines.push(serializeLine(block.spans));
    else if (block.type === "bullets") for (const item of block.items) lines.push(`- ${serializeLine(item)}`);
    else block.items.forEach((item, index) => lines.push(`${index + 1}. ${serializeLine(item)}`));
  }
  return lines.join("\n");
}

const lineText = (line: RichLine) => line.map((span) => span.text).join("");

/** The words alone, one line per paragraph or item, for labels and search. */
export function richTextPlain(source: string): string {
  return parseRichText(source)
    .flatMap((block) => (block.type === "paragraph" ? [lineText(block.spans)] : block.items.map(lineText)))
    .join("\n");
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function lineHtml(line: RichLine): string {
  if (line.length === 0) return "<br>";
  return line
    .map(({ text, marks }) => {
      let html = escapeHtml(text);
      if (marks.underline) html = `<u>${html}</u>`;
      if (marks.italic) html = `<i>${html}</i>`;
      if (marks.bold) html = `<b>${html}</b>`;
      if (marks.href) html = `<a href="${escapeHtml(marks.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

/**
 * The HTML an editor starts from: a div per paragraph, lists as lists, and
 * every word escaped. Only the tags written here ever appear.
 */
export function richTextHtml(source: string): string {
  return parseRichText(source)
    .map((block) => {
      if (block.type === "paragraph") return `<div>${lineHtml(block.spans)}</div>`;
      const tag = block.type === "bullets" ? "ul" : "ol";
      return `<${tag}>${block.items.map((item) => `<li>${lineHtml(item)}</li>`).join("")}</${tag}>`;
    })
    .join("");
}
