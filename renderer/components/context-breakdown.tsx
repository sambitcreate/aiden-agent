// Context detail shown in Quick View and the Context tool: where the next
// request's tokens go, drawn as 100 tiles over the model's whole context window
// with a bar per category. Every number comes from the main process projection
// (ChatContextPressureV1); nothing is re-estimated here.

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  contextPressurePercent,
  formatContextTokenCount,
  type ChatContextPressureV1,
  type DeferredContextCategory,
} from "../shared/context-pressure";
import {
  ContextTiles,
  FREE_COLOR,
  RESERVED_FILL,
  contextSegments,
  freeContextTokens,
} from "./context-tiles";

const DEFERRED_LABELS: Record<DeferredContextCategory["id"], { row: string; fold: string }> = {
  "mcp-tools": { row: "MCP tools (deferred)", fold: "MCP tools by server" },
};

function percentOfWindow(tokens: number, contextWindow: number): string {
  return contextWindow > 0 ? `${((tokens / contextWindow) * 100).toFixed(1)}%` : "—";
}

function pluralMessages(count: number): string {
  return `${count} earlier ${count === 1 ? "message" : "messages"}`;
}

export function compactionNote(pressure: ChatContextPressureV1, approaching: boolean, compacting: boolean): string {
  if (compacting) return "Compacting context…";
  if (pressure.shouldCompact) return "Aiden will compact context before the next request.";
  const count = pressure.compressibleHistoryMessages;
  if (count === 0) return "Healthy. No earlier messages to compact yet.";
  return approaching
    ? `Approaching the limit. ${pluralMessages(count)} can be compacted.`
    : `Healthy. ${pluralMessages(count)} could be compacted later.`;
}

/** Same presentation threshold as the composer ContextMeter; shouldCompact stays the runtime rule. */
export function contextApproaching(pressure: ChatContextPressureV1, compacting: boolean): boolean {
  return compacting || pressure.shouldCompact || pressure.percentOfUsableInput >= 80;
}

/** Soft status pill: green while healthy, warning once compaction is near or running. */
export function ContextStatus({
  warning,
  children,
  role,
  className,
}: React.PropsWithChildren<{ warning: boolean; role?: "note"; className?: string }>) {
  return (
    <p
      role={role}
      className={cn(
        "m-0 inline-flex max-w-full items-start gap-1.5 rounded-control px-2.5 py-1 text-small leading-snug",
        warning ? "bg-status-warning-surface text-status-warning" : "bg-status-green-surface text-status-green",
        className,
      )}
    >
      <span aria-hidden="true" className="mt-[0.45em] size-1.5 shrink-0 rounded-full bg-current" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function CategoryRow({
  label,
  tokens,
  ofWindow,
  fill,
  share,
}: {
  label: string;
  tokens: number;
  /** Percent of the whole context window, e.g. "4.6%". */
  ofWindow: string;
  fill: string;
  /** Bar length as a fraction of the largest category. */
  share: number;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-regular text-primary">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: fill }} />
        <span data-legend-label="" className="min-w-0 truncate">
          {label}
        </span>
      </span>
      <span className="text-small text-tertiary tabular-nums">
        {formatContextTokenCount(tokens)}
        <span className="ml-2 inline-block min-w-[3.2em] text-right text-secondary">{ofWindow}</span>
      </span>
      <span aria-hidden="true" className="col-span-2 h-1 overflow-hidden rounded-full bg-control">
        <span
          className="block h-full rounded-full transition-[width] duration-(--motion-large-duration) ease-standard motion-reduce:transition-none"
          style={{ width: `${Math.max(1.5, share * 100)}%`, background: fill }}
        />
      </span>
    </li>
  );
}

function QuietRow({
  label,
  tokens,
  swatch,
  notCounted = false,
}: {
  label: string;
  tokens: number;
  swatch: React.CSSProperties;
  notCounted?: boolean;
}) {
  return (
    <li className="flex items-center gap-2 text-small text-tertiary">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={swatch} />
      <span data-legend-label="" className="min-w-0 truncate">
        {label}
      </span>
      {notCounted ? <span className="shrink-0 whitespace-nowrap text-mini">not counted</span> : null}
      <span className="ml-auto tabular-nums">{formatContextTokenCount(tokens)}</span>
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
  layout = "card",
}: {
  pressure: ChatContextPressureV1;
  /** A compaction is running for this chat right now. */
  compacting?: boolean;
  /** `card`: Quick View's narrow column. `panel`: the Context tool, with the square grid beside the bars. */
  layout?: "card" | "panel";
}): React.JSX.Element {
  const percent = contextPressurePercent(pressure);
  const approaching = contextApproaching(pressure, compacting);
  const segments = contextSegments(pressure);
  const largest = segments[0]?.tokens ?? 0;
  const free = freeContextTokens(pressure);
  const deferred = pressure.breakdown?.deferred ?? [];
  const estimate = pressure.source === "estimated" ? "~" : "";
  const tileTokens = formatContextTokenCount(Math.round(pressure.contextWindow / 100));
  const panel = layout === "panel";

  const headline = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span
        className={cn(
          "font-semibold tracking-tight tabular-nums",
          panel ? "text-[calc(var(--ui-font-size)*3)] leading-none" : "text-heading1",
          approaching ? "text-support-warning" : "text-primary",
        )}
      >
        {`${percent}%`}{" "}
        <span className="text-regular font-normal tracking-normal text-secondary">used</span>
      </span>
      <span className="text-small text-tertiary tabular-nums">
        {`${estimate}${formatContextTokenCount(pressure.contextTokens)} of ${formatContextTokenCount(pressure.inputBudgetTokens)} usable`}
      </span>
    </div>
  );

  const legend = (
    <ul aria-label="Context by category" className="m-0 grid list-none gap-2.5 p-0">
      {segments.map((segment) => (
        <CategoryRow
          key={segment.key}
          label={segment.label}
          tokens={segment.tokens}
          ofWindow={percentOfWindow(segment.tokens, pressure.contextWindow)}
          fill={segment.fill}
          share={largest > 0 ? segment.tokens / largest : 0}
        />
      ))}
      <li aria-hidden="true" className="h-px bg-separator" />
      <QuietRow label="Reserved for response" tokens={pressure.reservedTokens} swatch={{ background: RESERVED_FILL }} />
      <QuietRow label="Free space" tokens={free} swatch={{ background: FREE_COLOR }} />
      {deferred.map((entry) => (
        <QuietRow
          key={`deferred-${entry.id}`}
          label={DEFERRED_LABELS[entry.id].row}
          tokens={entry.tokens}
          swatch={{ boxShadow: "inset 0 0 0 1.5px var(--text-tertiary)" }}
          notCounted
        />
      ))}
    </ul>
  );

  const caption = (
    <span className="text-mini text-tertiary">
      {`Each tile is ${tileTokens} tokens, 1% of the ${formatContextTokenCount(pressure.contextWindow)} window`}
    </span>
  );

  return (
    <div className={cn(panel ? "" : "px-2.5 pt-0.5 pb-2")}>
      {panel ? (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <div className="flex w-full max-w-44 shrink-0 flex-col gap-1.5">
            <ContextTiles pressure={pressure} columns={10} />
            {caption}
          </div>
          <div className="min-w-52 flex-1">
            {headline}
            <div className="mt-4">{legend}</div>
          </div>
        </div>
      ) : (
        <>
          {headline}
          <div className="mt-3 mb-1.5">
            <ContextTiles pressure={pressure} columns={20} />
          </div>
          <div className="mb-3">{caption}</div>
          {legend}
        </>
      )}

      {deferred.map((entry) => (
        <DeferredFold key={`fold-${entry.id}`} deferred={entry} />
      ))}

      <ContextStatus role="note" warning={approaching} className="mt-3">
        {compactionNote(pressure, approaching, compacting)}
        {deferred.length > 0 ? " Deferred tools load through tool search and aren't counted until used." : null}
      </ContextStatus>
    </div>
  );
}
