// A note's or text item's words as they read when nobody is editing them:
// the Markdown subset drawn as React elements, so nothing in it can run.
// Links open with ⌘-click (Ctrl-click elsewhere), since a plain click selects.

import * as React from "react";
import { cn } from "../../lib/ui-utils";
import { parseRichText, type RichLine } from "../../shared/design-canvas/rich-text";

/** Opens a link in a note when the click is a ⌘- or Ctrl-click; true when it did. */
export function openRichLink(event: React.MouseEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  const href = anchor?.getAttribute("href");
  if (!href) return false;
  event.preventDefault();
  event.stopPropagation();
  window.open(href, "_blank", "noopener,noreferrer");
  return true;
}

function Line({ line }: { line: RichLine }) {
  if (line.length === 0) return <br />;
  return (
    <>
      {line.map(({ text, marks }, index) => {
        let node: React.ReactNode = text;
        if (marks.underline) node = <u>{node}</u>;
        if (marks.italic) node = <i>{node}</i>;
        if (marks.bold) node = <b>{node}</b>;
        if (marks.href) {
          node = (
            <a href={marks.href} title={marks.href} onClick={(event) => event.preventDefault()}>
              {node}
            </a>
          );
        }
        return <React.Fragment key={index}>{node}</React.Fragment>;
      })}
    </>
  );
}

export function RichTextView({ value, className }: { value: string; className?: string }) {
  const blocks = React.useMemo(() => parseRichText(value), [value]);
  return (
    <div className={cn("design-rich-text whitespace-pre-wrap break-words", className)} onClickCapture={openRichLink}>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return (
            <div key={index}>
              <Line line={block.spans} />
            </div>
          );
        }
        const List = block.type === "bullets" ? "ul" : "ol";
        return (
          <List key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Line line={item} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
