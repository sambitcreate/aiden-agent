// Fenced code block for the chat transcript: syntax highlighting via highlight.js,
// a language label, and a per-block copy button. Source formatting is preserved
// so a valid-looking JSON prefix never reformats and jumps while streaming.
// Grammars load lazily per language; the block renders as plain text until its
// grammar is ready, and unlabeled fences stay plain text (no auto-detection).
// Highlighting is memoized so streaming re-renders stay cheap.

import * as React from "react";
import { CopyButton } from "./copy-button";
import {
  highlightCode,
  highlightLanguagesVersion,
  loadHighlightLanguage,
  subscribeHighlightLanguages,
} from "../lib/syntax-highlight";

interface CodeBlockProps {
  /** Raw code text (without the enclosing fence). */
  code: string;
  /** Language hint parsed from the ```lang fence, if any. */
  lang?: string;
  /** Skip highlighting, e.g. while a streamed fence is still growing. */
  plain?: boolean;
}

export const CodeBlock = React.memo(function CodeBlock({ code, lang, plain = false }: CodeBlockProps) {
  const display = code.replace(/\n$/, "");
  const language = lang;
  // Changes when any lazily loaded grammar lands, re-running the memo below.
  const grammarsVersion = React.useSyncExternalStore(
    subscribeHighlightLanguages,
    highlightLanguagesVersion,
    highlightLanguagesVersion,
  );

  React.useEffect(() => {
    void loadHighlightLanguage(language);
  }, [language]);

  const html = React.useMemo(
    () => (plain ? null : highlightCode(display, language)),
    [display, language, plain, grammarsVersion],
  );

  return (
    <div className="group/code my-2 overflow-hidden rounded-lg bg-well">
      <div className="flex items-center justify-between border-b border-separator/60 px-3 py-1">
        <span className="font-mono text-mini uppercase tracking-wide text-tertiary">
          {language || "text"}
        </span>
        <CopyButton
          text={display}
          label="Copy code"
          className="opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      </div>
      <pre className="code-font-sized overflow-x-auto p-3 leading-relaxed">
        {html ? (
          <code className="hljs font-mono text-small" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="hljs font-mono text-small">{display}</code>
        )}
      </pre>
    </div>
  );
});
