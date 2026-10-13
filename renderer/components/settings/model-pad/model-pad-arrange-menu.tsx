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
  type ModelPadMetric,
} from "../../../lib/model-pad-layout";
import { cn } from "../../../lib/ui-utils";

export const MODEL_PAD_METRICS: readonly ModelPadMetric[] = ["intelligence", "coding", "agentic"];

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
  const reasonId = React.useId();
  return (
    <DropdownMenuItem
      aria-labelledby={labelId}
      aria-describedby={unavailableReason ? reasonId : undefined}
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
          <span className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
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
          className="model-pad-segments mx-1 mb-1 grid grid-cols-3 gap-0.5 rounded-control bg-control p-0.5"
        >
          {MODEL_PAD_METRICS.map((option) => (
            <DropdownMenuPrimitive.RadioItem
              key={option}
              value={option}
              // Switching the score keeps the menu open, like a segmented control.
              onSelect={(event) => event.preventDefault()}
              className="model-pad-segment flex h-6 cursor-default select-none items-center justify-center rounded-[10px] text-small text-secondary outline-none transition-colors duration-(--motion-duration) ease-standard hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring data-[state=checked]:bg-popover data-[state=checked]:text-primary data-[state=checked]:shadow-control"
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
 * The Pad's corner chip naming the score behind benchmark heights. It opens a
 * menu to switch the score.
 */
export function ModelPadMetricChip({
  metric,
  onMetricChange,
}: {
  metric: ModelPadMetric;
  onMetricChange: (metric: ModelPadMetric) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${modelPadHeightCaption(metric)} score. Change the benchmark score`}
          className="model-pad-metric-chip"
        >
          {MODEL_PAD_METRIC_LABELS[metric]}
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
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
