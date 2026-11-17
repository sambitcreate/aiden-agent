import * as React from "react";
import { cn } from "../lib/ui-utils";

const DesignCanvas = React.lazy(() => import("./design-canvas"));

/**
 * The canvas side of design mode. Split, it sits beside the chat column.
 * Stacked (content too narrow for both), it fills the chat area below the top
 * bar while the Chat | Canvas switch shows it, and is hidden from sight, focus
 * and assistive tech while the chat is shown. It stays mounted either way, so
 * the canvas keeps its viewport. The canvas inside names the landmark, so this
 * wrapper adds none of its own.
 */
export function DesignCanvasRegion({
  chatId,
  width,
  placement,
  hidden,
  stackedTopInset = 0,
}: {
  chatId: string;
  width: number;
  placement: "split" | "stacked";
  hidden: boolean;
  /** Extra room below the top bar when stacked, such as the top bar's design mode banner. */
  stackedTopInset?: number;
}) {
  return (
    <section
      data-design-canvas-region={placement}
      data-chat-id={chatId}
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={cn(
        "design-canvas-region min-h-0 overflow-hidden bg-background",
        placement === "stacked" ? "absolute inset-x-0 bottom-0 top-13 z-20" : "relative h-full shrink-0",
        hidden && "invisible",
      )}
      style={
        placement === "split"
          ? { width }
          : stackedTopInset > 0
            ? { top: `calc(3.25rem + ${stackedTopInset}px)` }
            : undefined
      }
    >
      <React.Suspense fallback={<DesignCanvasLoading />}>
        {/* Each chat has its own canvas, so its tool and viewport never carry over. */}
        <DesignCanvas key={chatId} chatId={chatId} />
      </React.Suspense>
    </section>
  );
}

/**
 * Shown while the canvas chunk loads. Deliberately neutral: it must not look
 * like an empty canvas that is missing its tools.
 */
function DesignCanvasLoading() {
  return (
    <div role="status" aria-label="Loading canvas" className="flex h-full items-center justify-center">
      <div aria-hidden className="h-24 w-40 animate-pulse rounded-button bg-control motion-reduce:animate-none" />
    </div>
  );
}
