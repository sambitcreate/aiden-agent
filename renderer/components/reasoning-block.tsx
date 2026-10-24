import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  reasoningDisclosureLayout,
} from "../lib/reasoning-disclosure";
import { useStickySectionCollapse } from "../lib/sticky-section";
import { DisclosureCollapseBoundary } from "./disclosure-collapse-boundary";

interface ReasoningBlockProps {
  content: string;
  /** The provider may still append reasoning deltas. */
  streaming?: boolean;
  /** The model is actively thinking before its first answer token. */
  active?: boolean;
  /** Header text; active state is communicated by the shimmer. */
  label?: string;
  /** Automatic preview visibility; manual disclosure choices take priority. */
  automaticOpen?: boolean;
}

/** A quiet, bounded view of reasoning deliberately exposed by a supported provider. */
export function ReasoningBlock({
  content,
  streaming = false,
  active = false,
  label = "Thinking",
  automaticOpen = streaming,
}: ReasoningBlockProps) {
  if (!content.trim()) {
    return (
      <div role="status" aria-live="polite" className="reasoning-surface rounded-card bg-well px-3 py-2 text-small-strong text-secondary">
        <span className={cn(active && "agent-thinking-shimmer")}>{label}</span>
      </div>
    );
  }
  return <ReadableReasoningBlock content={content} streaming={streaming} active={active} label={label} automaticOpen={automaticOpen} />;
}

function ReadableReasoningBlock({
  content,
  streaming = false,
  active = false,
  label = "Thinking",
  automaticOpen = streaming,
}: ReasoningBlockProps) {
  const contentId = React.useId();
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const followTailRef = React.useRef(streaming);
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const expanded = choice ?? automaticOpen;
  const layout = reasoningDisclosureLayout({ expanded, userControlled: choice !== null });
  const regionLabel = label === "Thinking" ? "Model reasoning" : label;
  const { sectionRef, headerRef, noteCollapse, noteAutomaticCollapse, restoreAfterCollapse, onFocusCapture } =
    useStickySectionCollapse<HTMLElement, HTMLButtonElement>();
  const [atTop, setAtTop] = React.useState(true);
  const [atBottom, setAtBottom] = React.useState(true);

  const updateScrollEdges = React.useCallback((element = viewportRef.current) => {
    if (!element) return;
    setAtTop(element.scrollTop < 2);
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 2);
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
  }, [layout, updateScrollEdges]);

  return (
    <DisclosureCollapseBoundary expanded={expanded} beforeCollapse={noteAutomaticCollapse} afterCollapse={restoreAfterCollapse}>
    <section
      ref={sectionRef}
      onFocusCapture={onFocusCapture}
      data-disclosure-layout={layout}
      className="transcript-sticky-section reasoning-surface rounded-card bg-well text-small text-secondary outline-none"
      data-streaming={active ? "true" : "false"}
    >
      <button
        ref={headerRef}
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        data-surface="well"
        onClick={() => {
          if (expanded) noteCollapse();
          setChoice(!expanded);
        }}
        className="transcript-sticky-header flex h-9 w-full items-center gap-2 rounded-card px-3 text-left text-small-strong text-secondary outline-none transition-[background-color,color,box-shadow] duration-150 ease-out hover:text-primary focus-visible:outline-none"
      >
        <span className={cn("min-w-0 flex-1", active && "agent-thinking-shimmer")}>{label}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-tertiary transition-transform duration-150 ease-out",
            expanded && "rotate-90",
          )}
        />
      </button>
      {layout === "full" ? (
        // Deliberately opened: the reasoning flows at full height in the
        // transcript and the sticky header keeps the disclosure reachable.
        <div
          id={contentId}
          className="px-3.5 pb-3 text-small leading-relaxed"
          role="region"
          aria-label={regionLabel}
        >
          <p className="whitespace-pre-wrap break-words">{content}</p>
        </div>
      ) : layout === "preview" ? (
        <div
          id={contentId}
          ref={viewportRef}
          className="scroll-edge-mask max-h-36 overflow-y-auto px-3.5 pb-3 text-small leading-relaxed outline-none"
          data-scroll-top={atTop}
          data-scroll-bottom={atBottom}
          role="region"
          aria-label={regionLabel}
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
    </DisclosureCollapseBoundary>
  );
}
