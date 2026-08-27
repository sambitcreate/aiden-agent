import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  REASONING_PREVIEW_MS,
  initialReasoningDisclosure,
  reduceReasoningDisclosure,
} from "../lib/reasoning-disclosure";

interface ReasoningBlockProps {
  content: string;
  /** The provider may still append reasoning deltas. */
  streaming?: boolean;
  /** The model is actively thinking before its first answer token. */
  active?: boolean;
  /** Header verb; "…" is appended while active. */
  label?: string;
}

/** A quiet, bounded view of reasoning deliberately exposed by a supported provider. */
export function ReasoningBlock({
  content,
  streaming = false,
  active = false,
  label = "Thinking",
}: ReasoningBlockProps) {
  const contentId = React.useId();
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const followTailRef = React.useRef(streaming);
  const previewOnMountRef = React.useRef(streaming);
  const [disclosure, dispatchDisclosure] = React.useReducer(
    reduceReasoningDisclosure,
    streaming,
    initialReasoningDisclosure,
  );
  const { expanded } = disclosure;
  const [atTop, setAtTop] = React.useState(true);
  const [atBottom, setAtBottom] = React.useState(true);

  const updateScrollEdges = React.useCallback((element = viewportRef.current) => {
    if (!element) return;
    setAtTop(element.scrollTop < 2);
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 2);
  }, []);

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
    if (!element) return;
    if (streaming && followTailRef.current) element.scrollTop = element.scrollHeight;
    updateScrollEdges(element);
  }, [content, expanded, streaming, updateScrollEdges]);

  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => updateScrollEdges(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, updateScrollEdges]);

  return (
    <section
      className="reasoning-surface rounded-card bg-well text-small text-secondary outline-none"
      data-streaming={active ? "true" : "false"}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => dispatchDisclosure({ type: "toggle" })}
        className="flex h-9 w-full items-center gap-2 rounded-card px-3 text-left text-small-strong text-secondary outline-none transition-[background-color,color,box-shadow] duration-150 ease-out hover:bg-list-hover hover:text-primary focus-visible:bg-list-selection focus-visible:outline-none"
      >
        <span className={cn("min-w-0 flex-1", active && "agent-thinking-shimmer")}>
          {active ? `${label}…` : label}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-tertiary transition-transform duration-150 ease-out",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <div
          id={contentId}
          ref={viewportRef}
          className="scroll-edge-mask max-h-36 overflow-y-auto px-3.5 pb-3 text-small leading-relaxed outline-none"
          data-scroll-top={atTop}
          data-scroll-bottom={atBottom}
          role="region"
          aria-label={label === "Thinking" ? "Model reasoning" : label}
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            const nextAtBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 2;
            followTailRef.current = nextAtBottom;
            updateScrollEdges(element);
          }}
        >
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
      ) : null}
    </section>
  );
}
