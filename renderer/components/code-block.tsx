// Fenced code block for the chat transcript: syntax highlighting via highlight.js,
// a language label, and a per-block copy button. Source formatting is preserved
// so a valid-looking JSON prefix never reformats and jumps while streaming.
// Grammars load lazily per language; the block renders as plain text until its
// grammar is ready, and unlabeled fences stay plain text (no auto-detection).
// Highlighting is memoized so streaming re-renders stay cheap.
// Closed ```svg fences in chat replies can also be previewed as a drawing.

import * as React from "react";
import { Code, Eye } from "lucide-react";
import { CopyButton, inlineActionButtonClassName } from "./copy-button";
import { cn } from "../lib/ui-utils";
import { svgPreviewSource } from "../lib/svg-fence-preview";
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
  /** Offer a Preview toggle on svg fences (chat replies only, not render_ui). */
  previewable?: boolean;
}

// Header actions stay hidden until the block is hovered or an action has focus.
const HEADER_ACTION_VISIBILITY =
  "opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100";

export const CodeBlock = React.memo(function CodeBlock({
  code,
  lang,
  plain = false,
  previewable = false,
}: CodeBlockProps) {
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

  const previewSrc = React.useMemo(
    () => (previewable && !plain ? svgPreviewSource(display, language) : null),
    [display, language, plain, previewable],
  );
  const [previewing, setPreviewing] = React.useState(false);
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showPreview = previewing && previewSrc !== null;

  return (
    <div className="group/code my-2 overflow-hidden rounded-lg bg-well">
      <div className="flex items-center justify-between border-b border-separator/60 px-3 py-1">
        <span className="font-mono text-mini uppercase tracking-wide text-tertiary">
          {language || "text"}
        </span>
        <div className="flex items-center gap-0.5">
          {previewSrc !== null && (
            <button
              type="button"
              aria-label="Preview"
              aria-pressed={showPreview}
              title={showPreview ? "Show code" : "Preview"}
              onClick={() => setPreviewing((value) => !value)}
              className={cn(
                inlineActionButtonClassName,
                HEADER_ACTION_VISIBILITY,
                // Keep the way back to the code in view while the drawing shows.
                "aria-pressed:bg-list-selection aria-pressed:opacity-100",
              )}
            >
              {showPreview ? (
                <Code aria-hidden="true" className="size-3.5" />
              ) : (
                <Eye aria-hidden="true" className="size-3.5" />
              )}
            </button>
          )}
          <CopyButton text={display} label="Copy code" className={HEADER_ACTION_VISIBILITY} />
        </div>
      </div>
      {showPreview ? (
        <div className="p-3">
          {failedSrc === previewSrc ? (
            <p className="text-small text-secondary">Couldn't draw this SVG.</p>
          ) : (
            // White paper in every theme: agent SVGs usually draw black on transparent.
            <img
              src={previewSrc}
              alt="SVG preview"
              onError={() => setFailedSrc(previewSrc)}
              className="mx-auto block max-h-[32rem] max-w-full rounded-card bg-[#fff] object-contain p-3"
            />
          )}
        </div>
      ) : (
        <pre className="code-font-sized overflow-x-auto p-3 leading-relaxed">
          {html ? (
            <code
              className="hljs font-mono text-small"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <code className="hljs font-mono text-small">{display}</code>
          )}
        </pre>
      )}
    </div>
  );
});
