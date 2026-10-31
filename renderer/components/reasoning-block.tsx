import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/ui-utils";
import { latestReasoningLine, reduceReasoningDisclosure } from "../lib/reasoning-disclosure";
import { useStickySectionCollapse } from "../lib/sticky-section";
import { pauseWhenUnseen } from "../lib/offscreen-pause";

interface ReasoningBlockProps {
  content: string;
  /** The provider may still append reasoning deltas. */
  streaming?: boolean;
  /** The model is actively thinking before its first answer token. */
  active?: boolean;
  /** Header text; active state is communicated by the shimmer. */
  label?: string;
}

/** Folding motion is opt-in on the document, like the CSS that eases it. */
function disclosureMotionAllowed(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "false";
}

/**
 * A quiet, one-row view of reasoning deliberately exposed by a supported
 * provider. It never opens or closes on its own: while the model thinks, the
 * row rolls the latest finished line in place, so a fast turn with many short
 * thoughts never moves the transcript. Opening it is the reader's choice, and
 * the reasoning then flows at full height under a sticky header.
 */
export function ReasoningBlock({
  content,
  streaming = false,
  active = false,
  label = "Thinking",
}: ReasoningBlockProps) {
  const contentId = React.useId();
  const [phase, dispatchPhase] = React.useReducer(reduceReasoningDisclosure, "closed");
  const expanded = phase === "open";
  const readable = Boolean(content.trim());
  const regionLabel = label === "Thinking" ? "Model reasoning" : label;
  const { sectionRef, headerRef, noteCollapse, restoreAfterCollapse } =
    useStickySectionCollapse<HTMLElement, HTMLButtonElement>();

  // The live line keeps its last text once thinking ends so it can fade out
  // in place; stored reasoning never showed one.
  const liveLine = active && streaming ? latestReasoningLine(content) : "";
  const [lastLine, setLastLine] = React.useState(liveLine);
  if (liveLine && liveLine !== lastLine) setLastLine(liveLine);
  const line = liveLine || lastLine;
  const lineVisible = Boolean(liveLine) && !expanded;

  React.useLayoutEffect(() => {
    if (!expanded) restoreAfterCollapse();
  }, [expanded, restoreAfterCollapse]);

  React.useEffect(() => {
    if (phase !== "closing") return;
    // Lands the fold even when no transition runs to its end.
    const timer = window.setTimeout(() => dispatchPhase({ type: "closed" }), 320);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <section
      ref={sectionRef}
      role={readable ? undefined : "status"}
      aria-live={readable ? undefined : "polite"}
      data-disclosure-layout={expanded ? "full" : "collapsed"}
      className="transcript-sticky-section reasoning-surface rounded-card bg-well text-small text-secondary outline-none"
      data-streaming={active ? "true" : "false"}
    >
      <button
        ref={headerRef}
        type="button"
        disabled={!readable}
        aria-expanded={expanded}
        aria-controls={readable && phase !== "closed" ? contentId : undefined}
        data-surface="well"
        onClick={() => {
          if (expanded) noteCollapse();
          dispatchPhase({ type: "toggle", animate: disclosureMotionAllowed() });
        }}
        className="transcript-sticky-header flex h-9 w-full items-center gap-2.5 rounded-card px-3 text-left text-small-strong text-secondary outline-none transition-[background-color,color,box-shadow] duration-150 ease-out enabled:hover:text-primary focus-visible:outline-none disabled:cursor-default"
      >
        <span ref={active ? pauseWhenUnseen : undefined} className={cn("shrink-0", active && "agent-thinking-shimmer")}>{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "min-w-0 flex-1 truncate text-small font-normal text-tertiary transition-opacity duration-300 ease-out",
            !lineVisible && "opacity-0",
          )}
        >
          {line ? (
            <span key={line} className="reasoning-line-in">
              {line}
            </span>
          ) : null}
        </span>
        {readable ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-tertiary transition-transform duration-150 ease-out",
              expanded && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {readable && phase !== "closed" ? (
        <div
          className="reasoning-body"
          data-state={phase}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "grid-template-rows") {
              dispatchPhase({ type: "closed" });
            }
          }}
        >
          <div id={contentId} role="region" aria-label={regionLabel}>
            <div className="px-3.5 pb-3 text-small leading-relaxed">
              <p className="whitespace-pre-wrap break-words">{content}</p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
