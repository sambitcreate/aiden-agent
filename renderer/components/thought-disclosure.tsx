// One provider-exposed thinking segment inside a work group. Collapsed it is a
// quiet "Thought · preview…" line; expanding it never expands siblings. A live
// thought may preview briefly, then settles collapsed — user toggles always win.
// Callers pass only segments that actually have reasoning text; empty segments
// keep the ordinary thinking milestone row.

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  REASONING_PREVIEW_MS,
  initialReasoningDisclosure,
  reduceReasoningDisclosure,
} from "../lib/reasoning-disclosure";
import type { AgentThinkingStep } from "../shared/generation-timeline";

const COLLAPSED_PREVIEW_CHARS = 80;

function collapsedPreview(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > COLLAPSED_PREVIEW_CHARS
    ? `${flat.slice(0, COLLAPSED_PREVIEW_CHARS)}…`
    : flat;
}

export function ThoughtDisclosure({
  step,
  text,
  streaming = false,
}: {
  step: AgentThinkingStep;
  /** This segment's slice of the canonical reasoning buffer (non-empty). */
  text: string;
  /** The turn is still streaming, so an open thought may preview briefly. */
  streaming?: boolean;
}) {
  const contentId = React.useId();
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const followTailRef = React.useRef(true);
  const active = streaming && step.finishedAt === undefined;
  const previewOnMountRef = React.useRef(active);
  const [disclosure, dispatchDisclosure] = React.useReducer(
    reduceReasoningDisclosure,
    active,
    initialReasoningDisclosure,
  );
  const { expanded } = disclosure;

  const body = text.trim();

  React.useEffect(() => {
    if (!previewOnMountRef.current) return;
    const timer = window.setTimeout(
      () => dispatchDisclosure({ type: "preview-elapsed" }),
      REASONING_PREVIEW_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || !expanded) return;
    if (active && followTailRef.current) element.scrollTop = element.scrollHeight;
  }, [text, expanded, active]);

  return (
    <div className="min-w-0 py-px" role="listitem">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={expanded ? "Thought, expanded" : "Thought, collapsed"}
        onClick={() => dispatchDisclosure({ type: "toggle" })}
        className="-mx-1 flex h-5 w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-control px-1 text-left outline-none transition-colors hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-tertiary transition-transform duration-150 ease-out",
            expanded && "rotate-90",
          )}
        />
        <span
          className={cn(
            "activity-feed-detail-label min-w-0 truncate text-mini text-secondary",
            active && "agent-thinking-shimmer",
          )}
        >
          <span className="font-medium">{active ? "Thinking" : "Thought"}</span>
          {!expanded && body ? (
            <span className="text-tertiary"> · {collapsedPreview(body)}</span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div
          id={contentId}
          ref={viewportRef}
          className="mb-1 ml-4 mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-mini leading-relaxed text-secondary outline-none"
          role="region"
          aria-label="Thought"
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            followTailRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 2;
          }}
        >
          {body}
        </div>
      ) : null}
    </div>
  );
}
