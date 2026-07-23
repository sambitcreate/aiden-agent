import * as React from "react";

interface ReasoningBlockProps {
  content: string;
  streaming?: boolean;
}

/** A quiet, bounded view of reasoning explicitly emitted by a local model. */
export function ReasoningBlock({ content, streaming = false }: ReasoningBlockProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const followTailRef = React.useRef(streaming);
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
  }, [content, streaming, updateScrollEdges]);

  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => updateScrollEdges(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateScrollEdges]);

  return (
    <div
      ref={viewportRef}
      className="reasoning-surface scroll-edge-mask max-h-36 overflow-y-auto rounded-card bg-well px-3.5 py-3 text-small leading-relaxed text-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      data-scroll-top={atTop}
      data-scroll-bottom={atBottom}
      data-streaming={streaming ? "true" : "false"}
      role="region"
      aria-label="Model reasoning"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        const nextAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 2;
        followTailRef.current = nextAtBottom;
        updateScrollEdges(element);
      }}
    >
      <p className="whitespace-pre-wrap break-words">{content}</p>
    </div>
  );
}
