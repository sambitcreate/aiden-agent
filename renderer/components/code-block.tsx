// Fenced code block for the chat transcript: syntax highlighting via highlight.js,
// pretty-printed JSON, a language label, and a per-block copy button.
// Highlighting is memoized so streaming re-renders stay cheap.

import * as React from "react";
import hljs from "highlight.js";
import { CopyButton } from "./copy-button";

interface CodeBlockProps {
  /** Raw code text (without the enclosing fence). */
  code: string;
  /** Language hint parsed from the ```lang fence, if any. */
  lang?: string;
  revealGroups?: Array<{ id: string; text: string }>;
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

export const CodeBlock = React.memo(function CodeBlock({
  code,
  lang,
  revealGroups,
}: CodeBlockProps) {
  const raw = code.replace(/\n$/, "");

  // Pretty-print JSON (explicit ```json or content that parses as JSON).
  const { display, language } = React.useMemo(() => {
    if (lang === "json" || (!lang && looksLikeJson(raw))) {
      try {
        return { display: JSON.stringify(JSON.parse(raw), null, 2), language: "json" };
      } catch {
        // Incomplete/invalid JSON (common mid-stream): fall through to raw.
      }
    }
    return { display: raw, language: lang };
  }, [raw, lang]);

  const html = React.useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(display, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(display).value;
    } catch {
      return null;
    }
  }, [display, language]);

  return (
    <div className="group/code my-2 overflow-hidden rounded-lg border border-separator bg-well">
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
        {revealGroups ? (
          <code className="hljs font-mono text-small">
            {revealGroups.map((group) => (
              <span key={group.id} className="streaming-reveal-unit block">
                {group.text}
              </span>
            ))}
          </code>
        ) : html ? (
          <code className="hljs font-mono text-small" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code className="hljs font-mono text-small">{display}</code>
        )}
      </pre>
    </div>
  );
});
