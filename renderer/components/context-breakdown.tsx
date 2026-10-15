// Quick View's expanded Context detail: where the next request's tokens go,
// drawn over the model's whole context window. Every number comes from the
// main process projection (ChatContextPressureV1); nothing is re-estimated here.

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  contextPressurePercent,
  formatContextTokenCount,
  type ChatContextPressureV1,
  type ContextCategoryId,
  type DeferredContextCategory,
} from "../shared/context-pressure";

const CATEGORY_LABELS: Record<ContextCategoryId, string> = {
  "system-prompt": "System prompt",
  "builtin-tools": "Built-in tools",
  "mcp-tools": "MCP tools",
  skills: "Skills",
  memory: "Memory",
  "project-instructions": "Project instructions",
  "mcp-instructions": "MCP server instructions",
  "bot-instructions": "Bot instructions",
};

// Bot instructions shares chart-7 with project instructions: the two never carry distinct meaning together.
const CATEGORY_COLORS: Record<ContextCategoryId, string> = {
  "builtin-tools": "var(--chart-2)",
  "system-prompt": "var(--chart-3)",
  "mcp-tools": "var(--chart-4)",
  skills: "var(--chart-5)",
  memory: "var(--chart-6)",
  "project-instructions": "var(--chart-7)",
  "mcp-instructions": "var(--chart-8)",
  "bot-instructions": "var(--chart-7)",
};

const MESSAGES_COLOR = "var(--chart-1)";
const FALLBACK_STATIC_COLOR = "var(--chart-2)";
const FREE_COLOR = "var(--surface-control)";
const RESERVED_FILL =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--text-tertiary) 45%, transparent) 0 2px, transparent 2px 5px)";

const DEFERRED_LABELS: Record<DeferredContextCategory["id"], { row: string; fold: string }> = {
  "mcp-tools": { row: "MCP tools (deferred)", fold: "MCP tools by server" },
};

interface Segment {
  key: string;
  label: string;
  tokens: number;
  fill: string;
}

function usedSegments(pressure: ChatContextPressureV1): Segment[] {
  const statics: Segment[] = pressure.breakdown
    ? pressure.breakdown.categories.map((category) => ({
        key: category.id,
        label: CATEGORY_LABELS[category.id],
        tokens: category.tokens,
        fill: CATEGORY_COLORS[category.id],
      }))
    : [{ key: "static", label: "System prompt & tools", tokens: pressure.staticTokens, fill: FALLBACK_STATIC_COLOR }];
  return [{ key: "messages", label: "Messages", tokens: pressure.messageTokens, fill: MESSAGES_COLOR }, ...statics]
    .filter((segment) => segment.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);
}

function percentOfWindow(tokens: number, contextWindow: number): string {
  return contextWindow > 0 ? `${((tokens / contextWindow) * 100).toFixed(1)}%` : "—";
}

function pluralMessages(count: number): string {
  return `${count} earlier ${count === 1 ? "message" : "messages"}`;
}

function compactionNote(pressure: ChatContextPressureV1, approaching: boolean, compacting: boolean): string {
  if (compacting) return "Compacting context…";
  if (pressure.shouldCompact) return "Aiden will compact context before the next request.";
  const count = pressure.compressibleHistoryMessages;
  if (count === 0) return "Healthy. No earlier messages to compact yet.";
  return approaching
    ? `Approaching the limit. ${pluralMessages(count)} can be compacted.`
    : `Healthy. ${pluralMessages(count)} could be compacted later.`;
}

function LegendRow({
  label,
  tokens,
  percent,
  fill,
  muted = false,
  notCounted = false,
  className,
}: {
  label: string;
  tokens: number;
  percent: string;
  fill: string;
  muted?: boolean;
  notCounted?: boolean;
  className?: string;
}) {
  return (
    <li className={cn("col-span-4 grid grid-cols-subgrid items-center", muted ? "text-tertiary" : "text-secondary", className)}>
      <span aria-hidden="true" className="size-2.5 rounded-[3px]" style={{ background: fill }} />
      <span data-legend-label="" className="min-w-0 truncate">
        {label}
      </span>
      <span className="text-right text-small text-tertiary tabular-nums">{formatContextTokenCount(tokens)}</span>
      {notCounted ? (
        <span aria-label="not counted" className="text-right tabular-nums">
          —
        </span>
      ) : (
        <span className="text-right tabular-nums">{percent}</span>
      )}
    </li>
  );
}

function DeferredFold({ deferred }: { deferred: DeferredContextCategory }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const label = DEFERRED_LABELS[deferred.id].fold;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="-mx-2.5 mt-1.5 flex min-h-8 w-[calc(100%+1.25rem)] items-center gap-2 rounded-control px-2.5 text-left text-regular text-secondary outline-none transition-colors duration-150 ease-out hover:bg-list-hover hover:text-primary focus-visible:bg-list-selection focus-visible:text-primary motion-reduce:transition-none"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-tertiary transition-transform duration-(--motion-duration) ease-standard motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span>{label}</span>
        <span className="ml-auto text-small text-tertiary tabular-nums">{deferred.count}</span>
      </button>
      {open ? (
        <ul
          id={listId}
          aria-label={label}
          className="m-0 grid list-none grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1 p-0 pt-1 pb-0.5 pl-6 text-small text-tertiary"
        >
          {deferred.servers.map((server) => (
            <li key={server.name} className="col-span-3 grid grid-cols-subgrid">
              <span className="min-w-0 truncate text-secondary">{server.name}</span>
              <span className="text-right tabular-nums">{`${server.count} ${server.count === 1 ? "tool" : "tools"}`}</span>
              <span className="text-right tabular-nums">{formatContextTokenCount(server.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function ContextBreakdown({
  pressure,
  compacting = false,
}: {
  pressure: ChatContextPressureV1;
  /** A compaction is running for this chat right now. */
  compacting?: boolean;
}): React.JSX.Element {
  const percent = contextPressurePercent(pressure);
  // Same presentation thresholds as the composer ContextMeter; shouldCompact stays the runtime rule.
  const approaching = compacting || pressure.shouldCompact || pressure.percentOfUsableInput >= 80;
  const contextWindow = pressure.contextWindow;
  const segments = usedSegments(pressure);
  const free = Math.max(0, pressure.inputBudgetTokens - pressure.contextTokens);
  const deferred = pressure.breakdown?.deferred ?? [];
  const budgetMarker = contextWindow > 0 ? Math.min(100, (pressure.inputBudgetTokens / contextWindow) * 100) : null;
  const estimate = pressure.source === "estimated" ? "~" : "";

  const barLabel = [
    ...segments.map((segment) => `${segment.label} ${formatContextTokenCount(segment.tokens)}`),
    `Free space ${formatContextTokenCount(free)}`,
    `Reserved for response ${formatContextTokenCount(pressure.reservedTokens)}`,
  ].join(", ");

  return (
    <div className="px-2.5 pt-0.5 pb-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("text-strong font-semibold tabular-nums", approaching ? "text-support-warning" : "text-primary")}>
          {`${percent}% used`}
        </span>
        <span className="text-small text-tertiary tabular-nums">
          {`${estimate}${formatContextTokenCount(pressure.contextTokens)} / ${formatContextTokenCount(pressure.inputBudgetTokens)} usable`}
        </span>
      </div>

      <div role="img" aria-label={barLabel} className="relative mt-2 mb-3 flex h-2 gap-0.5">
        {segments.map((segment) => (
          <span
            key={segment.key}
            title={`${segment.label} ${formatContextTokenCount(segment.tokens)}`}
            className="h-full min-w-0.5 rounded-[3px] transition-[flex-grow] duration-(--motion-large-duration) ease-standard motion-reduce:transition-none"
            style={{ flexGrow: segment.tokens, background: segment.fill }}
          />
        ))}
        <span className="h-full rounded-[3px]" style={{ flexGrow: free, background: FREE_COLOR }} />
        <span className="h-full rounded-[3px]" style={{ flexGrow: pressure.reservedTokens, background: RESERVED_FILL }} />
        {budgetMarker !== null ? (
          <span
            aria-hidden="true"
            title="Aiden compacts before a request would cross this line"
            className="absolute -top-[3px] -bottom-[3px] w-0.5 rounded-full bg-secondary"
            style={{ left: `calc(${budgetMarker}% - 1px)` }}
          />
        ) : null}
      </div>

      <ul
        aria-label="Context by category"
        className="m-0 grid list-none grid-cols-[10px_minmax(0,1fr)_auto_3.4em] items-center gap-x-2.5 gap-y-1.5 p-0 text-regular"
      >
        {segments.map((segment) => (
          <LegendRow
            key={segment.key}
            label={segment.label}
            tokens={segment.tokens}
            percent={percentOfWindow(segment.tokens, contextWindow)}
            fill={segment.fill}
          />
        ))}
        <LegendRow
          label="Reserved for response"
          tokens={pressure.reservedTokens}
          percent={percentOfWindow(pressure.reservedTokens, contextWindow)}
          fill={RESERVED_FILL}
        />
        <LegendRow label="Free space" tokens={free} percent={percentOfWindow(free, contextWindow)} fill={FREE_COLOR} />
        {deferred.map((entry, index) => (
          <LegendRow
            key={`deferred-${entry.id}`}
            label={DEFERRED_LABELS[entry.id].row}
            tokens={entry.tokens}
            percent="—"
            fill="var(--surface-control-hover)"
            muted
            notCounted
            className={index === 0 ? "mt-1" : undefined}
          />
        ))}
      </ul>

      {deferred.map((entry) => (
        <DeferredFold key={`fold-${entry.id}`} deferred={entry} />
      ))}

      <p role="note" className={cn("m-0 mt-3 text-small leading-snug", approaching ? "text-support-warning" : "text-tertiary")}>
        {compactionNote(pressure, approaching, compacting)}
        {deferred.length > 0 ? " Deferred tools load through tool search and aren't counted until used." : null}
      </p>
    </div>
  );
}
