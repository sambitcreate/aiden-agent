import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { ChevronDown, MoreHorizontal, Wand2 } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui";
import {
  MODEL_PAD_METRIC_LABELS,
  modelPadHeightCaption,
  type ModelPadHeightMetric,
  type ModelPadMetric,
} from "../../../lib/model-pad-layout";
import { MODEL_PAD_METRICS } from "../../../shared/model-pad-preferences";
import { cn } from "../../../lib/ui-utils";

type CloseAutoFocus = (event: Event) => void;

/**
 * A menu action that can be unavailable. It stays focusable (aria-disabled)
 * and shows why underneath, so keyboard and screen reader users hear the
 * reason; choosing it then does nothing and keeps the menu open.
 */
function ModelPadMenuAction({
  label,
  detail,
  unavailableReason,
  destructive = false,
  onSelect,
}: {
  label: string;
  /** Trailing note, such as "3 ready". */
  detail?: string;
  unavailableReason?: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  const labelId = React.useId();
  const detailId = React.useId();
  const reasonId = React.useId();
  // The label alone names the item; the detail and the reason describe it.
  const describedBy = [detail ? detailId : null, unavailableReason ? reasonId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <DropdownMenuItem
      aria-labelledby={labelId}
      aria-describedby={describedBy || undefined}
      aria-disabled={unavailableReason ? true : undefined}
      color={destructive && !unavailableReason ? "status-red" : undefined}
      className={cn("group flex-col items-stretch gap-0", unavailableReason && "opacity-45")}
      onSelect={(event) => {
        if (unavailableReason) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      <span className="flex items-center gap-3">
        <span id={labelId} className="min-w-0 flex-1">
          {label}
        </span>
        {detail ? (
          <span
            id={detailId}
            className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground"
          >
            {detail}
          </span>
        ) : null}
      </span>
      {unavailableReason ? (
        <span
          id={reasonId}
          className="max-w-60 text-small text-tertiary group-data-[highlighted]:text-accent-foreground"
        >
          {unavailableReason}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

/**
 * Header menu for arranging the Pad from data: the benchmark score that sets
 * height (persisted), previewing benchmark suggestions, and pace from the
 * user's measured chat speed.
 */
export function ModelPadArrangeMenu({
  triggerRef,
  metric,
  onMetricChange,
  suggestUnavailableReason,
  onSuggest,
  paceReadyCount,
  paceUnavailableReason,
  onPace,
  onCloseAutoFocus,
}: {
  triggerRef?: React.Ref<HTMLButtonElement>;
  metric: ModelPadMetric;
  onMetricChange: (metric: ModelPadMetric) => void;
  suggestUnavailableReason?: string;
  onSuggest: () => void;
  paceReadyCount: number;
  paceUnavailableReason?: string;
  onPace: () => void;
  onCloseAutoFocus?: CloseAutoFocus;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} size="small" variant="transparent">
          <Wand2 aria-hidden="true" />
          Arrange
          <ChevronDown aria-hidden="true" className="size-3.5 text-tertiary" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuLabel className="text-mini text-tertiary">
          Height from benchmark scores
        </DropdownMenuLabel>
        <DropdownMenuPrimitive.RadioGroup
          aria-label="Benchmark score for height"
          value={metric}
          onValueChange={(value) => onMetricChange(value as ModelPadMetric)}
          className="mx-1 mb-1 grid grid-cols-3 gap-0.5 rounded-control bg-control p-0.5"
        >
          {MODEL_PAD_METRICS.map((option) => (
            <DropdownMenuPrimitive.RadioItem
              key={option}
              value={option}
              // Switching the score keeps the menu open, like a segmented control.
              onSelect={(event) => event.preventDefault()}
              className="flex h-6 cursor-default select-none items-center justify-center rounded-menu text-small text-secondary outline-none transition-colors duration-(--motion-duration) ease-standard hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring data-[state=checked]:bg-popover data-[state=checked]:text-primary data-[state=checked]:shadow-control"
            >
              {MODEL_PAD_METRIC_LABELS[option]}
            </DropdownMenuPrimitive.RadioItem>
          ))}
        </DropdownMenuPrimitive.RadioGroup>
        <ModelPadMenuAction
          label="Suggest models"
          unavailableReason={suggestUnavailableReason}
          onSelect={onSuggest}
        />
        <DropdownMenuSeparator />
        <ModelPadMenuAction
          label="Pace from my chats"
          detail={paceReadyCount > 0 && !paceUnavailableReason ? `${paceReadyCount} ready` : undefined}
          unavailableReason={paceUnavailableReason}
          onSelect={onPace}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The header's ⋯ menu: actions that change the whole Pad. */
export function ModelPadMoreMenu({
  removeAllUnavailableReason,
  onRemoveAll,
}: {
  removeAllUnavailableReason?: string;
  onRemoveAll: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="small" variant="transparent" iconOnly aria-label="More Pad actions">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <ModelPadMenuAction
          label="Remove all"
          destructive
          unavailableReason={removeAllUnavailableReason}
          onSelect={onRemoveAll}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Pad header's chip naming the score behind benchmark heights. It opens a
 * menu to switch the score.
 */
export function ModelPadMetricChip({
  metric,
  heightMetric,
  onMetricChange,
  onRemovedWithFocus,
}: {
  /** The chosen score: new suggestions and the next re-rank use it. */
  metric: ModelPadMetric;
  /** The score the shown heights came from, or "mixed" when they differ. */
  heightMetric: ModelPadHeightMetric;
  onMetricChange: (metric: ModelPadMetric) => void;
  /** The chip is leaving the page while it or its menu holds focus. */
  onRemovedWithFocus: () => void;
}) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // Whether focus was last inside the chip or its menu. A closing menu drops
  // focus to the page body before handing it back to the trigger, so the chip
  // can go away while nothing holds focus; it still counts as the chip's then.
  const heldFocusRef = React.useRef(false);
  const onRemovedWithFocusRef = React.useRef(onRemovedWithFocus);
  React.useLayoutEffect(() => {
    onRemovedWithFocusRef.current = onRemovedWithFocus;
  });
  const inside = (node: EventTarget | Element | null) =>
    node instanceof Node &&
    Boolean(triggerRef.current?.contains(node) || contentRef.current?.contains(node));
  const trackFocus = {
    onFocusCapture: () => {
      heldFocusRef.current = true;
    },
    onBlurCapture: (event: React.FocusEvent) => {
      // Focus moved to another real control: no longer the chip's.
      if (event.relatedTarget && !inside(event.relatedTarget)) heldFocusRef.current = false;
    },
  };
  // Layout cleanup runs before React removes the chip, while focus may still be inside it.
  React.useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || !active.isConnected;
      if (inside(active) || (lost && heldFocusRef.current)) onRemovedWithFocusRef.current();
    },
    // `inside` reads refs only, so the mount-time copy stays correct.
    [],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          {...trackFocus}
          aria-label={`${modelPadHeightCaption(heightMetric)} score${heightMetric === "mixed" ? "s" : ""}. Change the benchmark score`}
          className="model-pad-metric-chip"
        >
          {modelPadHeightCaption(heightMetric)}
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={contentRef} align="end" className="min-w-40" {...trackFocus}>
        <DropdownMenuLabel className="text-mini text-tertiary">Height from</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={metric}
          onValueChange={(value) => onMetricChange(value as ModelPadMetric)}
        >
          {MODEL_PAD_METRICS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {MODEL_PAD_METRIC_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
