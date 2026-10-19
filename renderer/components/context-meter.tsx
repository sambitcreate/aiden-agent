// Quiet composer indicator for next-request context pressure. Numbers come
// from the runtime's own projectNextContextUsage projection, so the meter
// trips exactly when Aiden would compact; estimated figures carry a ~ prefix.

import * as React from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "./ui";
import { ContextStatus } from "./context-breakdown";
import { ContextPips, ContextTiles } from "./context-tiles";
import { cn } from "../lib/ui-utils";
import {
  contextPressurePercent,
  formatContextTokenCount,
  type ChatContextPressureV1,
} from "../shared/context-pressure";

export type ContextMeterPhase =
  "normal" | "approaching" | "compaction-pending" | "compacting" | "compacted";

export function contextMeterPhase(
  pressure: ChatContextPressureV1,
  compacting: boolean,
  recentlyCompacted: boolean,
): ContextMeterPhase {
  if (compacting) return "compacting";
  if (pressure.shouldCompact) return "compaction-pending";
  if (recentlyCompacted) return "compacted";
  // "Approaching" is a presentation threshold only — the runtime rule
  // (shouldCompact) stays the single source of truth for compaction.
  if (pressure.percentOfUsableInput >= 80) return "approaching";
  return "normal";
}

function tokenLabel(pressure: ChatContextPressureV1, value: number): string {
  return `${pressure.source === "estimated" ? "~" : ""}${formatContextTokenCount(value)}`;
}

export function ContextMeter({
  pressure,
  compacting = false,
  recentlyCompacted = false,
  onViewDetails,
}: {
  pressure: ChatContextPressureV1 | null | undefined;
  compacting?: boolean;
  recentlyCompacted?: boolean;
  onViewDetails?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const detailsRequested = React.useRef(false);
  if (!pressure) return null;
  const percent = contextPressurePercent(pressure);
  const phase = contextMeterPhase(pressure, compacting, recentlyCompacted);
  const emphasized = phase === "compaction-pending" || phase === "compacting";
  const stateText =
    phase === "compaction-pending"
      ? "Aiden will compact context before the next request."
      : phase === "compacting"
        ? "Compacting context…"
        : phase === "compacted"
          ? "Context compacted."
          : pressure.shouldCompact
            ? "Aiden will compact context before the next request."
            : phase === "approaching"
              ? "Approaching the limit. Aiden compacts before a request would cross it."
              : "Context healthy. No compaction needed before the next request.";
  const warning = emphasized || phase === "approaching";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          className={cn(
            "h-7 gap-1 px-1.5",
            emphasized ? "text-support-warning" : "text-secondary",
            phase === "compacting" && "agent-thinking-shimmer",
          )}
          aria-label={`Context usage, ${percent} percent${emphasized ? ", will compact before the next request" : ""}`}
          title="Projected context for the next request"
        >
          <ContextPips percent={percent} warning={warning} />
          <span className="context-meter-percent text-mini tabular-nums">{percent}%</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3.5"
        align="end"
        side="top"
        aria-label="Context usage"
        onCloseAutoFocus={(event) => { if (detailsRequested.current) { event.preventDefault(); detailsRequested.current = false; } }}
      >
        <ContextMeterDetails
          pressure={pressure}
          percent={percent}
          emphasized={warning}
          stateText={stateText}
        />
        {onViewDetails ? <Button variant="muted" size="small" className="mt-3 w-full" onClick={() => { detailsRequested.current = true; setOpen(false); onViewDetails(); }}>View context details</Button> : null}
      </PopoverContent>
    </Popover>
  );
}

/** Popover body: the tile grid beside the headline, then labelled terms (dt) with their token values (dd). */
export function ContextMeterDetails({
  pressure,
  percent,
  emphasized,
  stateText,
}: {
  pressure: ChatContextPressureV1;
  percent: number;
  emphasized: boolean;
  stateText: string;
}) {
  const rows: Array<[string, string]> = [
    ["conversation", `~${formatContextTokenCount(pressure.messageTokens)}`],
    ["system + tools", `~${formatContextTokenCount(pressure.staticTokens)}`],
  ];
  if (pressure.addedAfterUsageAnchorTokens !== undefined) {
    rows.push(["recent work", `~${formatContextTokenCount(pressure.addedAfterUsageAnchorTokens)}`]);
  }
  rows.push(["reserved", `~${formatContextTokenCount(pressure.reservedTokens)}`]);
  rows.push(["model context", formatContextTokenCount(pressure.contextWindow)]);
  return (
    <>
      <div className="flex items-start gap-3.5">
        <div className="flex w-20 shrink-0 flex-col gap-1">
          <ContextTiles pressure={pressure} columns={10} />
          <span className="text-mini text-tertiary">1% per tile</span>
        </div>
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-heading1 font-semibold tracking-tight tabular-nums",
              emphasized ? "text-support-warning" : "text-primary",
            )}
          >
            {percent}%
          </span>
          <span className="mt-0.5 block text-small text-secondary tabular-nums">
            {`${tokenLabel(pressure, pressure.contextTokens)} of ${formatContextTokenCount(pressure.inputBudgetTokens)} usable`}
          </span>
          <dl className="mt-2.5 space-y-1 text-small">
            {rows.map(([term, value]) => (
              <div key={term} className="flex items-baseline justify-between gap-3">
                <dt className="whitespace-nowrap text-tertiary">{term}</dt>
                <dd className="text-secondary tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <ContextStatus warning={emphasized} className="mt-3">
        {stateText}
      </ContextStatus>
    </>
  );
}
