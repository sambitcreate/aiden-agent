// Markdown renderer for assistant messages. Streaming-safe (re-renders on each
// delta) and styled with semantic tokens so it respects light/dark.
// Supports GFM tables, LaTeX (KaTeX), and rich code blocks (syntax highlighting,
// JSON formatting, per-block copy) via the CodeBlock component.

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "../lib/ui-utils";
import { CodeBlock } from "./code-block";
import "katex/dist/katex.min.css";

interface MarkdownProps {
  content: string;
}

const components: Components = {
  // Unwrap <pre> — CodeBlock renders its own container/scroller.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || "");
    const text = String(children ?? "");
    const isBlock = !!match || text.includes("\n");
    if (isBlock) {
      return <CodeBlock code={text} lang={match?.[1]} />;
    }
    return (
      <code className="rounded-md bg-well px-1.5 py-0.5 font-mono text-[0.9em]">{children}</code>
    );
  },
};

export const Markdown = React.memo(function Markdown({ content }: MarkdownProps) {
  return (
    <div
      className={cn(
        "select-text text-regular text-primary leading-relaxed",
        "[&_p]:my-2 first:[&_p]:mt-0 last:[&_p]:mb-0",
        "[&_h1]:text-large-strong [&_h2]:text-strong [&_h3]:text-strong [&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-3 [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-1",
        "[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5",
        "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-separator [&_blockquote]:pl-3 [&_blockquote]:text-secondary [&_blockquote]:my-2",
        "[&_table]:my-2 [&_table]:w-full [&_table]:block [&_table]:overflow-x-auto [&_th]:text-left [&_th]:border-b [&_th]:border-separator [&_th]:py-1 [&_th]:px-2 [&_td]:py-1 [&_td]:px-2 [&_td]:border-b [&_td]:border-separator/50",
        "[&_hr]:my-3 [&_hr]:border-separator",
        // KaTeX display math should scroll rather than overflow the bubble.
        "[&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
