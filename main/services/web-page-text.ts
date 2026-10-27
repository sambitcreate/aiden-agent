/**
 * A fetched page as plain text lines for `web_fetch`.
 *
 * HTML becomes one line per block (headings marked with `#`, list items with
 * `- `, table cells joined by ` | `), without scripts, styles, navigation,
 * footers or hidden elements, and without link addresses. Keeping a value and
 * its label on one line is what lets extract mode cite the line it came from.
 */

import type { DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;
type Element = DefaultTreeAdapterTypes.Element;

export interface WebPageText {
  readonly title: string;
  readonly text: string;
}

const SKIPPED = new Set([
  "head", "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe",
  "object", "embed", "nav", "footer", "aside", "dialog", "select", "option",
]);
const BLOCKS = new Set([
  "address", "article", "blockquote", "body", "caption", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "html", "li", "main", "ol", "p", "pre", "section", "summary", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);
const CELLS = new Set(["td", "th"]);

let parser: Promise<typeof import("parse5")> | undefined;

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function hidden(element: Element): boolean {
  if (attribute(element, "hidden") !== undefined) return true;
  if (attribute(element, "aria-hidden") === "true") return true;
  const style = attribute(element, "style")?.replace(/\s+/gu, "").toLowerCase();
  return style !== undefined && (style.includes("display:none") || style.includes("visibility:hidden"));
}

class LineWriter {
  private readonly lines: string[] = [];
  private current = "";
  private prefix = "";
  private cellCount = 0;

  text(value: string): void {
    const collapsed = value.replace(/\s+/gu, " ");
    if (!collapsed.trim()) {
      if (this.current && !this.current.endsWith(" ")) this.current += " ";
      return;
    }
    if (!this.current) this.current = this.prefix + collapsed.trimStart();
    else this.current += this.current.endsWith(" ") ? collapsed.trimStart() : collapsed;
  }

  preformatted(value: string): void {
    this.flush();
    for (const line of value.replace(/\r\n?/gu, "\n").split("\n")) this.lines.push(line.trimEnd());
  }

  cell(): void {
    if (this.cellCount > 0 && this.current.trim()) this.current = `${this.current.trimEnd()} | `;
    this.cellCount += 1;
  }

  startBlock(prefix = ""): void {
    // A block that opens before any text keeps the pending marker: <li><p>.
    const pending = this.current.trim() ? "" : this.prefix;
    this.flush();
    // One blank line before a heading keeps sections apart; nothing else adds lines.
    if (prefix.startsWith("#") && this.lines.length && this.lines[this.lines.length - 1] !== "") this.lines.push("");
    this.prefix = prefix || pending;
  }

  flush(): void {
    const line = this.current.trim();
    if (line && line !== this.prefix.trim()) this.lines.push(line.replace(/\s*\|\s*$/u, ""));
    this.current = "";
    this.prefix = "";
  }

  endRow(): void {
    this.flush();
    this.cellCount = 0;
  }

  result(): string {
    this.flush();
    return this.lines.join("\n").trim();
  }
}

function titleOf(head: Element): string {
  const title = head.childNodes.find((child) => (child as Element).tagName === "title") as Element | undefined;
  return (title?.childNodes ?? [])
    .map((child) => (child.nodeName === "#text" ? (child as DefaultTreeAdapterTypes.TextNode).value : ""))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function headingLevel(tag: string): number {
  return /^h[1-6]$/u.test(tag) ? Number(tag[1]) : 0;
}

/** HTML to text lines. parse5 loads on first use, off the startup path. */
export async function htmlToPageText(html: string): Promise<WebPageText> {
  const { parse } = await (parser ??= import("parse5"));
  const document = parse(html);
  const writer = new LineWriter();
  let title = "";
  let cellDepth = 0;
  // Explicit stack: a deeply nested page must not overflow the call stack.
  const stack: Array<{ node: Node; exit?: string }> = [{ node: document }];
  while (stack.length > 0) {
    const { node, exit } = stack.pop()!;
    if (exit !== undefined) {
      if (CELLS.has(exit)) cellDepth -= 1;
      if (exit === "tr") writer.endRow();
      else if (BLOCKS.has(exit) && !CELLS.has(exit)) {
        // Blocks inside a table cell stay on the row's line.
        if (cellDepth > 0) writer.text(" ");
        else writer.flush();
      }
      continue;
    }
    if (node.nodeName === "#text") {
      writer.text((node as DefaultTreeAdapterTypes.TextNode).value);
      continue;
    }
    if (node.nodeName === "#comment" || node.nodeName === "#documentType") continue;
    const element = node as Element;
    const tag = element.tagName;
    if (tag === "head") title ||= titleOf(element);
    if (tag !== undefined) {
      if (SKIPPED.has(tag) || hidden(element)) continue;
      if (tag === "br") {
        writer.flush();
        continue;
      }
      if (tag === "pre") {
        const text: string[] = [];
        const inner: Node[] = [...element.childNodes].reverse();
        while (inner.length) {
          const child = inner.pop()!;
          if (child.nodeName === "#text") text.push((child as DefaultTreeAdapterTypes.TextNode).value);
          else if ("childNodes" in child) inner.push(...[...child.childNodes].reverse());
        }
        writer.preformatted(text.join(""));
        continue;
      }
      if (CELLS.has(tag)) {
        writer.cell();
        cellDepth += 1;
      } else if (cellDepth > 0 && BLOCKS.has(tag) && tag !== "tr" && tag !== "table") writer.text(" ");
      else if (BLOCKS.has(tag)) {
        const level = headingLevel(tag);
        writer.startBlock(level ? `${"#".repeat(level)} ` : tag === "li" ? "- " : "");
      }
      stack.push({ node, exit: tag });
    }
    const children = "childNodes" in node ? node.childNodes : [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index]! });
  }
  return { title, text: writer.result() };
}

/** Non-HTML text bodies are used as they are, with line endings made plain. */
export function plainPageText(body: string): WebPageText {
  return { title: "", text: body.replace(/\r\n?/gu, "\n").trim() };
}
