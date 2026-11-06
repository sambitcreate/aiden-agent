// Present: the Present button at the canvas's top right, the bar along the
// bottom while presenting, and the keys that step through the frames.

import { ChevronLeft, ChevronRight, Play, X } from "lucide-react";
import type { Viewport } from "@xyflow/react";
import { Button } from "../components/ui";
import type { CanvasKeyEvent } from "../canvas/canvas-keymap-core";

export type DesignPresentation = {
  /** The frames shown, in order. */
  ids: string[];
  index: number;
  /** One frame shown alone (Open full window), rather than the whole page. */
  single: boolean;
  /** Where the canvas looked before, to go back to on exit. */
  restore: Viewport;
};

export type DesignPresentKey = "next" | "previous" | "first" | "last" | "exit";

/** What a key does while presenting, or null when it does nothing. */
export function presentationKey(event: Pick<CanvasKeyEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">): DesignPresentKey | null {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case "Escape":
      return "exit";
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

export function DesignPresentButton({ onPresent }: { onPresent(): void }) {
  return (
    <div className="glass-surface rounded-button p-1 shadow-control">
      <Button variant="transparent" aria-label="Present this page" title="Present" onClick={onPresent}>
        <Play aria-hidden />
        {/* A narrow canvas keeps the tools whole and shows the button as its icon. */}
        <span className="@max-[40rem]:hidden">Present</span>
      </Button>
    </div>
  );
}

export function DesignPresentBar({
  presentation,
  title,
  onStep,
  onExit,
}: {
  presentation: DesignPresentation;
  title: string;
  onStep(to: "next" | "previous"): void;
  onExit(): void;
}) {
  const { ids, index, single } = presentation;
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-4 flex justify-center">
      <div
        role="toolbar"
        aria-label={single ? "Full window" : "Presentation"}
        className="glass-surface pointer-events-auto flex max-w-full items-center gap-1 rounded-button p-1 shadow-control"
      >
        {single ? null : (
          <Button
            iconOnly
            variant="transparent"
            aria-label="Previous frame"
            title="Previous (←)"
            disabled={index === 0}
            onClick={() => onStep("previous")}
          >
            <ChevronLeft aria-hidden />
          </Button>
        )}
        <span aria-live="polite" className="min-w-0 truncate px-2 text-secondary">
          {single ? title : `${index + 1} of ${ids.length}`}
          {!single && title ? <span className="text-primary"> · {title}</span> : null}
        </span>
        {single ? null : (
          <Button
            iconOnly
            variant="transparent"
            aria-label="Next frame"
            title="Next (→)"
            disabled={index === ids.length - 1}
            onClick={() => onStep("next")}
          >
            <ChevronRight aria-hidden />
          </Button>
        )}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        <Button
          variant="transparent"
          aria-label={single ? "Close full window" : "Stop presenting"}
          title={single ? "Close (Esc)" : "Stop presenting (Esc)"}
          onClick={onExit}
        >
          <X aria-hidden />
          <span>{single ? "Close" : "Exit"}</span>
        </Button>
      </div>
    </div>
  );
}
