// Reads what a person typed into a note's editor back as paragraphs and
// lists. The editor is a contenteditable element, so this takes whatever the
// browser made of the typing (divs, line breaks, b/i/u, links, styled spans)
// and keeps only what the Markdown subset can hold.

import {
  safeLinkHref,
  type RichBlock,
  type RichLine,
  type RichMarks,
} from "../shared/design-canvas/rich-text";

const BLOCK_TAGS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE"]);
const LIST_TAGS = new Set(["UL", "OL"]);
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

function marksOf(element: Element, marks: RichMarks): RichMarks {
  const next = { ...marks };
  const tag = element.tagName;
  if (tag === "B" || tag === "STRONG") next.bold = true;
  if (tag === "I" || tag === "EM") next.italic = true;
  if (tag === "U" || tag === "INS") next.underline = true;
  if (tag === "A") {
    const href = safeLinkHref(element.getAttribute("href") ?? "");
    if (href) next.href = href;
  }
  const style = (element as HTMLElement).style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) next.bold = true;
    if (style.fontStyle === "italic") next.italic = true;
    if (`${style.textDecoration} ${style.textDecorationLine}`.includes("underline")) next.underline = true;
  }
  return next;
}

function pushText(line: RichLine, text: string, marks: RichMarks) {
  if (!text) return;
  const last = line[line.length - 1];
  const same =
    last &&
    last.marks.bold === marks.bold &&
    last.marks.italic === marks.italic &&
    last.marks.underline === marks.underline &&
    last.marks.href === marks.href;
  if (same) last.text += text;
  else line.push({ text, marks: { ...marks } });
}

function addBlock(blocks: RichBlock[], block: RichBlock) {
  const last = blocks[blocks.length - 1];
  if (block.type !== "paragraph" && last && last.type === block.type) last.items.push(...block.items);
  else blocks.push(block);
}

function readContainer(node: Node, marks: RichMarks): RichBlock[] {
  const blocks: RichBlock[] = [];
  let line: RichLine | null = null;
  let afterBreak = false;

  const endLine = () => {
    if (line !== null) blocks.push({ type: "paragraph", spans: line });
    line = null;
    afterBreak = false;
  };

  const visitInline = (child: Node, current: RichMarks) => {
    if (child.nodeType === 3) {
      const text = (child.textContent ?? "").replace(/\u00a0/g, " ").replace(/\n/g, " ");
      if (!text) return;
      line ??= [];
      pushText(line, text, current);
      afterBreak = false;
      return;
    }
    if (child.nodeType !== 1) return;
    const element = child as Element;
    const tag = element.tagName;
    if (SKIPPED_TAGS.has(tag)) return;
    if (tag === "BR") {
      blocks.push({ type: "paragraph", spans: line ?? [] });
      line = [];
      afterBreak = true;
      return;
    }
    if (BLOCK_TAGS.has(tag) || LIST_TAGS.has(tag) || tag === "LI") {
      if (!(afterBreak && line !== null && line.length === 0)) endLine();
      line = null;
      afterBreak = false;
      const inner = marksOf(element, current);
      if (LIST_TAGS.has(tag)) {
        const type = tag === "UL" ? "bullets" : "numbers";
        const items: RichLine[] = [];
        for (const item of Array.from(element.childNodes)) {
          for (const block of readContainer(item, inner)) {
            if (block.type === "paragraph") items.push(block.spans);
            else items.push(...block.items);
          }
        }
        if (items.length > 0) addBlock(blocks, { type, items } as RichBlock);
      } else {
        for (const block of readContainer(element, inner)) addBlock(blocks, block);
      }
      return;
    }
    const inner = marksOf(element, current);
    for (const grandchild of Array.from(element.childNodes)) visitInline(grandchild, inner);
  };

  for (const child of Array.from(node.childNodes)) visitInline(child, marks);
  if (line !== null && !(afterBreak && (line as RichLine).length === 0)) endLine();
  return blocks;
}

/** The editor's contents as paragraphs and lists. */
export function readRichDom(root: Node): RichBlock[] {
  return readContainer(root, {});
}
