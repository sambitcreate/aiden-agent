// Quiet composer indicator for next-request context pressure. Numbers come
// from the runtime's own projectNextContextUsage projection, so the meter
// trips exactly when Aiden would compact; estimated figures carry a ~ prefix.

import { CircleGauge } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Text } from "./ui";
import { cn } from "../lib/ui-utils";
import {
  contextPressurePercent,
  formatContextTokenCount,
  type ChatContextPressureV1,
} from "../shared/context-pressure";

export type ContextMeterPhase =
  | "normal"
  | "approaching"
  | "compaction-pending"
  | "compacting"
  | "compacted";

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
}: {
  pressure: ChatContextPressureV1 | null | undefined;
  compacting?: boolean;
  recentlyCompacted?: boolean;
}) {
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
            : "Context healthy — no compaction needed before the next request.";

  return (
    <Popover>
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
          <CircleGauge aria-hidden="true" />
          <span className="text-mini tabular-nums">{percent}%</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end" side="top" aria-label="Context usage">
        <Text variant="small-strong" className="block text-primary">
          Context
        </Text>
        <Text variant="small" color="secondary" className="mt-1 block">
          {percent}% of usable context
        </Text>
        <dl className="mt-2 space-y-1 text-small">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-secondary">{tokenLabel(pressure, pressure.contextTokens)}</dt>
            <dd className="text-tertiary">projected tokens</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-secondary">{formatContextTokenCount(pressure.contextWindow)}</dt>
            <dd className="text-tertiary">model context</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-secondary">~{formatContextTokenCount(pressure.reservedTokens)}</dt>
            <dd className="text-tertiary">reserved for response + safety</dd>
          </div>
        </dl>
        <Text variant="small" color="tertiary" className="mt-3 block">
          {pressure.source === "provider-anchored"
            ? "Provider-reported composition"
            : "Estimated composition"}
        </Text>
        <dl className="mt-1 space-y-1 text-small">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-secondary">~{formatContextTokenCount(pressure.messageTokens)}</dt>
            <dd className="text-tertiary">conversation</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-secondary">~{formatContextTokenCount(pressure.staticTokens)}</dt>
            <dd className="text-tertiary">system + tools</dd>
          </div>
          {pressure.addedAfterUsageAnchorTokens !== undefined ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-secondary">
                ~{formatContextTokenCount(pressure.addedAfterUsageAnchorTokens)}
              </dt>
              <dd className="text-tertiary">recent work</dd>
            </div>
          ) : null}
        </dl>
        <Text
          variant="small"
          className={cn("mt-3 block", emphasized ? "text-support-warning" : "text-secondary")}
        >
          {stateText}
        </Text>
      </PopoverContent>
    </Popover>
  );
}
