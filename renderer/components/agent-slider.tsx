// The Agent Slider: one horizontal track with 3 to 7 stops. The thumb is the
// only focusable part (role="slider"); the arrow keys, Home and End move it
// between stops that can run, and a click or drag picks the stop under the
// pointer. A stop that can't run shows a hollow dot; choosing it never moves
// the chat but asks for a model instead. When the chat matches no stop
// (Custom) the thumb goes hollow, rests on the home stop, and the fill goes.

import * as React from "react";
import { RotateCcw, Zap } from "lucide-react";
import { Button } from "./ui";
import { cn } from "../lib/ui-utils";
import { isComposingKey } from "../lib/dismiss-key";
import {
  agentSliderValueText,
  edgeAgentSliderStop,
  stepAgentSliderStop,
  type AgentSliderPosition,
  type AgentSliderStopView,
} from "../lib/agent-slider-view";

/** Thumb diameter and its inset from the track's ends, in px. */
const THUMB = 28;
const INSET = 2;
/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

export interface AgentSliderProps {
  views: readonly AgentSliderStopView[];
  position: AgentSliderPosition;
  homeIndex: number;
  /** Custom: the chat's model in words, with its effort when known. */
  customDetail: string;
  disabled?: boolean;
  /** Why the slider can't move now, read with the thumb. */
  disabledReason?: string;
  /** A stop that can run was chosen. Never called for the chat's own stop. */
  onSelectStop: (index: number) => void;
  /** A stop that can't run was chosen: ask for a model for it. */
  onUnavailableStop: (index: number) => void;
  /** A printable key on the thumb: search the full model list for it. */
  onTypeToSearch: (character: string) => void;
  thumbRef?: React.Ref<HTMLDivElement>;
}

function stopFraction(index: number, count: number): number {
  return count <= 1 ? 0 : index / (count - 1);
}

export function AgentSlider({
  views,
  position,
  homeIndex,
  customDetail,
  disabled = false,
  disabledReason,
  onSelectStop,
  onUnavailableStop,
  onTypeToSearch,
  thumbRef,
}: AgentSliderProps) {
  const reasonId = React.useId();
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const localThumbRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<{ fraction: number; index: number } | null>(null);
  const pressRef = React.useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null);
  const suppressClickRef = React.useRef(false);
  const count = views.length;
  const home = views[homeIndex];

  const choose = (index: number) => {
    if (disabled) return;
    const view = views[index];
    if (!view) return;
    if (!view.available) {
      onUnavailableStop(index);
      return;
    }
    if (index !== position.stopIndex) onSelectStop(index);
  };

  const shownIndex = drag ? drag.index : position.custom ? -1 : position.stopIndex;
  const shown = shownIndex >= 0 ? views[shownIndex] : undefined;
  const custom = !drag && position.custom;
  const fraction = drag ? drag.fraction : stopFraction(position.thumbIndex, count);
  const thumbIndex = drag ? drag.index : position.thumbIndex;
  const valueText = drag
    ? agentSliderValueText(views, { stopIndex: drag.index, thumbIndex: drag.index, custom: false }, customDetail)
    : agentSliderValueText(views, position, customDetail);
  const heading = shown ? shown.label : "Custom";
  const detail = shown
    ? shown.available
      ? [shown.modelLabel, shown.effortLabel].filter(Boolean).join(" · ")
      : shown.reasonText
    : customDetail;

  const fractionAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= THUMB + INSET * 2) return fraction;
    const usable = rect.width - THUMB - INSET * 2;
    return Math.min(1, Math.max(0, (clientX - rect.left - INSET - THUMB / 2) / usable));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    pressRef.current = { pointerId: event.pointerId, startX: event.clientX, moved: false };
    suppressClickRef.current = false;
    // Keep focus on the thumb: no mouse-compatibility focus change follows.
    event.preventDefault();
    localThumbRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!press.moved && Math.abs(event.clientX - press.startX) < DRAG_THRESHOLD) return;
    if (!press.moved) {
      // Capture only once it is a drag, so a plain click still lands on its stop.
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A synthetic or already-released pointer: the drag follows the track only.
      }
    }
    press.moved = true;
    const next = fractionAt(event.clientX);
    setDrag({ fraction: next, index: Math.round(next * (count - 1)) });
  };
  const endPress = (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pressRef.current = null;
    if (!press.moved) return;
    // A drag ends on the stop nearest the pointer; the click that follows is not a second pick.
    suppressClickRef.current = true;
    const index = drag?.index;
    setDrag(null);
    if (commit && index !== undefined) choose(index);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKey(event)) return;
    let target: number | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
      case "PageUp":
        target = stepAgentSliderStop(views, position, 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
      case "PageDown":
        target = stepAgentSliderStop(views, position, -1);
        break;
      case "Home":
        target = edgeAgentSliderStop(views, "first");
        break;
      case "End":
        target = edgeAgentSliderStop(views, "last");
        break;
      default:
        if (
          event.key.length === 1 &&
          event.key.trim() !== "" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          onTypeToSearch(event.key);
        }
        return;
    }
    event.preventDefault();
    if (disabled || target === -1 || target === position.stopIndex) return;
    onSelectStop(target);
  };

  return (
    <div className="px-1.5 pt-1">
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_1.75rem] items-center gap-1">
        <span aria-hidden="true" className="flex justify-center text-tertiary">
          <Zap className="size-4" />
        </span>
        <div aria-hidden="true" className="min-w-0 text-center">
          <p className="truncate text-large-strong font-semibold text-primary" title={heading}>
            {heading}
          </p>
          <p className="truncate text-small text-secondary" title={detail}>
            {detail}
          </p>
        </div>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          aria-label={`Reset to ${home?.label ?? "the home stop"}`}
          title={`Reset to ${home?.label ?? "the home stop"}`}
          disabled={
            disabled ||
            !home?.available ||
            (!position.custom && position.stopIndex === homeIndex)
          }
          onClick={() => {
            if (home?.available) onSelectStop(homeIndex);
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
      <div
        ref={trackRef}
        data-agent-slider-track=""
        data-custom={custom || undefined}
        aria-disabled={disabled || undefined}
        className={cn(
          "relative mx-1 mt-3 mb-1 h-8 touch-none select-none rounded-pill bg-control transition-colors duration-(--motion-duration) ease-standard",
          disabled ? "opacity-45" : "hover:bg-control-hover",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endPress(event, true)}
        onPointerCancel={(event) => endPress(event, false)}
      >
        {/* The accent fill runs up to the thumb; Custom has none. */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 rounded-pill bg-fill-accent ease-standard",
            drag ? "transition-none" : "transition-[width,opacity] duration-(--motion-duration)",
            custom && "opacity-0",
          )}
          style={{ width: `calc(${THUMB + INSET * 2}px + (100% - ${THUMB + INSET * 2}px) * ${fraction})` }}
        />
        {views.map((view, index) => {
          const lit = !custom && view.available && index <= thumbIndex;
          return (
            <span
              key={view.id}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                !view.available
                  ? "size-2 bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-quaternary)]"
                  : lit
                    ? "size-1.5 bg-fill-accent-foreground/60"
                    : "size-1.5 bg-quaternary/50",
              )}
              style={{
                left: `calc(${INSET + THUMB / 2}px + (100% - ${THUMB + INSET * 2}px) * ${stopFraction(index, count)})`,
              }}
            />
          );
        })}
        {/* Click targets, one per stop, splitting the track between neighbours. */}
        {views.map((view, index) => {
          const half = count > 1 ? 50 / (count - 1) : 50;
          const center = stopFraction(index, count) * 100;
          return (
            <span
              key={`${view.id}-target`}
              aria-hidden="true"
              data-agent-slider-stop={index}
              data-available={view.available || undefined}
              title={view.available ? undefined : `${view.label}: ${view.reasonText}`}
              className="absolute inset-y-0"
              style={{
                left: `${Math.max(0, center - half)}%`,
                width: `${Math.min(100, center + half) - Math.max(0, center - half)}%`,
              }}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                choose(index);
              }}
            />
          );
        })}
        <div
          ref={(node) => {
            localThumbRef.current = node;
            if (typeof thumbRef === "function") thumbRef(node);
            else if (thumbRef) (thumbRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          role="slider"
          tabIndex={0}
          aria-label="Agent Slider"
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={count}
          aria-valuenow={thumbIndex + 1}
          aria-valuetext={valueText}
          aria-disabled={disabled || undefined}
          aria-describedby={disabled && disabledReason ? reasonId : undefined}
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full outline-none ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
            drag
              ? "transition-none"
              : "transition-[left,background-color,box-shadow] duration-(--motion-duration)",
            custom
              ? "bg-transparent shadow-[inset_0_0_0_2px_var(--color-quaternary)]"
              : "bg-white shadow-control",
          )}
          style={{
            width: THUMB,
            height: THUMB,
            left: `calc(${INSET}px + (100% - ${THUMB + INSET * 2}px) * ${fraction})`,
          }}
          onKeyDown={onKeyDown}
        />
        {disabled && disabledReason ? (
          <span id={reasonId} className="sr-only">
            {disabledReason}
          </span>
        ) : null}
      </div>
    </div>
  );
}
