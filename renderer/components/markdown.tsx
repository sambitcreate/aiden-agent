// Markdown renderer for assistant messages. Streaming-safe (re-renders on each
// delta) and styled with semantic tokens so it respects light/dark.
// Supports GFM tables, LaTeX (KaTeX), and rich code blocks (syntax highlighting,
// syntax highlighting and per-block copy) via the CodeBlock component.

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { cn } from "../lib/ui-utils";
import { CodeBlock } from "./code-block";

interface MarkdownProps {
  content: string;
}

export const MARKDOWN_CLASSNAME = cn(
  // Chat prose gets its own readable scale instead of inflating controls,
  // navigation, and settings through the global UI font-size preference.
  "select-text text-[calc(var(--ui-font-size)+1px)] leading-[1.56] text-primary",
  // Model output routinely contains unbroken runs (URLs, base64, hashes). Wrap
  // them instead of letting one token widen the transcript column. KaTeX lays
  // out its own boxes and scrolls horizontally, so it opts back out.
  "break-words [&_.katex]:break-normal",
  "[&_p]:my-3 [&_p]:max-w-[72ch] first:[&_p]:mt-0 last:[&_p]:mb-0",
  "[&_h1]:max-w-[72ch] [&_h2]:max-w-[72ch] [&_h3]:max-w-[72ch] [&_h1]:text-[1.22em] [&_h2]:text-[1.12em] [&_h3]:text-[1em] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-6 [&_h2]:mt-5 [&_h3]:mt-4 [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-1.5",
  "[&_strong]:font-semibold",
  "[&_ul]:my-3 [&_ul]:max-w-[72ch] [&_ul]:pl-6 [&_ul]:list-disc [&_ol]:my-3 [&_ol]:max-w-[72ch] [&_ol]:pl-6 [&_ol]:list-decimal [&_li]:my-1.5 [&_li>ul]:my-1.5 [&_li>ol]:my-1.5",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-3 [&_blockquote]:max-w-[72ch] [&_blockquote]:border-l-2 [&_blockquote]:border-separator [&_blockquote]:pl-3.5 [&_blockquote]:text-secondary",
  "[&_table]:my-2 [&_table]:w-full [&_table]:block [&_table]:overflow-x-auto [&_th]:text-left [&_th]:border-b [&_th]:border-separator [&_th]:py-1 [&_th]:px-2 [&_td]:py-1 [&_td]:px-2 [&_td]:border-b [&_td]:border-separator/50",
  "[&_hr]:my-3 [&_hr]:border-separator",
  "[&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1",
);

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

export const MarkdownContent = React.memo(function MarkdownContent({ content }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

export const Markdown = React.memo(function Markdown({ content }: MarkdownProps) {
  return (
    <div className={MARKDOWN_CLASSNAME}>
      <MarkdownContent content={content} />
    </div>
  );
});

const inlineComponents: Components = {
  ...components,
  p: ({ children }) => <>{children}</>,
};

export const MarkdownInline = React.memo(function MarkdownInline({ content }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={inlineComponents}
    >
      {content}
    </ReactMarkdown>
  );
});
