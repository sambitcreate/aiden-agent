// Shared context visuals: the 100-tile grid (each tile is 1% of the model's
// context window) and the composer's 10-pip meter. Every number comes from the
// main process projection (ChatContextPressureV1); nothing is re-estimated here.

import { cn } from "../lib/ui-utils";
import {
  formatContextTokenCount,
  type ContextMeterPressure,
  type ContextCategoryId,
} from "../shared/context-pressure";

export const CONTEXT_TILE_COUNT = 100;

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

export const MESSAGES_COLOR = "var(--chart-1)";
// Provider-counted excess: the Messages hue, faded, so it reads as "more of the
// conversation" and stays distinct from the hatched Reserved tiles.
const UNITEMIZED_COLOR = "color-mix(in srgb, var(--chart-1) 40%, transparent)";
const FALLBACK_STATIC_COLOR = "var(--chart-2)";
export const FREE_COLOR = "var(--surface-control)";
export const RESERVED_FILL =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--text-tertiary) 45%, transparent) 0 2px, transparent 2px 5px)";

export interface ContextSegment {
  key: string;
  label: string;
  tokens: number;
  fill: string;
}

/** Used context by category, largest first; zero-token categories are dropped. */
export function contextSegments(pressure: ContextMeterPressure): ContextSegment[] {
  const statics: ContextSegment[] = pressure.breakdown
    ? pressure.breakdown.categories.map((category) => ({
        key: category.id,
        label: CATEGORY_LABELS[category.id],
        tokens: category.tokens,
        fill: CATEGORY_COLORS[category.id],
      }))
    : [{ key: "static", label: "System prompt & tools", tokens: pressure.staticTokens, fill: FALLBACK_STATIC_COLOR }];
  // contextTokens can exceed the local itemization when the provider's reported
  // usage anchors the projection; show that excess instead of hiding it in Free.
  const unitemized: ContextSegment = {
    key: "unitemized",
    label: "Not itemized",
    tokens: Math.max(0, pressure.contextTokens - pressure.messageTokens - pressure.staticTokens),
    fill: UNITEMIZED_COLOR,
  };
  return [
    { key: "messages", label: "Messages", tokens: pressure.messageTokens, fill: MESSAGES_COLOR },
    ...statics,
    unitemized,
  ]
    .filter((segment) => segment.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);
}

export function freeContextTokens(pressure: ContextMeterPressure): number {
  return Math.max(0, pressure.inputBudgetTokens - pressure.contextTokens);
}

export type ContextTile =
  | { kind: "used"; segment: ContextSegment }
  | { kind: "free" }
  | { kind: "reserved" };

/**
 * Lays the window out as 100 tiles: used tiles per category (largest remainder,
 * so they always add up), then free, then the response reserve at the end.
 * Any used context or reserve shows at least one tile; an over-budget
 * projection takes tiles from the reserve once free space runs out.
 */
export function contextTiles(pressure: ContextMeterPressure): ContextTile[] {
  const window = pressure.contextWindow;
  if (window <= 0) return Array.from({ length: CONTEXT_TILE_COUNT }, () => ({ kind: "free" }) as const);
  const segments = contextSegments(pressure);
  const usedTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const share = (tokens: number) => (tokens / window) * CONTEXT_TILE_COUNT;
  const usedTiles =
    usedTokens > 0 ? Math.min(CONTEXT_TILE_COUNT, Math.max(1, Math.round(share(usedTokens)))) : 0;
  const reservedTiles = Math.min(
    CONTEXT_TILE_COUNT - usedTiles,
    pressure.reservedTokens > 0 ? Math.max(1, Math.round(share(pressure.reservedTokens))) : 0,
  );

  const exact = segments.map((segment) => (segment.tokens / usedTokens) * usedTiles);
  const counts = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder);
  for (let left = usedTiles - counts.reduce((sum, count) => sum + count, 0), i = 0; left > 0; left--, i++) {
    counts[order[i % order.length].index]++;
  }

  const tiles: ContextTile[] = [];
  segments.forEach((segment, index) => {
    for (let n = 0; n < counts[index]; n++) tiles.push({ kind: "used", segment });
  });
  while (tiles.length < CONTEXT_TILE_COUNT - reservedTiles) tiles.push({ kind: "free" });
  while (tiles.length < CONTEXT_TILE_COUNT) tiles.push({ kind: "reserved" });
  return tiles;
}

/** "Messages 46.3K, …, Free space 818.2K, Reserved for response 66.4K" for the grid's image label. */
export function contextTilesLabel(pressure: ContextMeterPressure): string {
  return [
    ...contextSegments(pressure).map((segment) => `${segment.label} ${formatContextTokenCount(segment.tokens)}`),
    `Free space ${formatContextTokenCount(freeContextTokens(pressure))}`,
    `Reserved for response ${formatContextTokenCount(pressure.reservedTokens)}`,
  ].join(", ");
}

export function ContextTiles({
  pressure,
  columns,
  className,
}: {
  pressure: ContextMeterPressure;
  /** 20 lays the grid out as a wide strip; 10 as a square. */
  columns: 10 | 20;
  className?: string;
}) {
  const tiles = contextTiles(pressure);
  return (
    <div
      role="img"
      aria-label={contextTilesLabel(pressure)}
      className={cn("grid gap-[3px]", className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {tiles.map((tile, index) => (
        <span
          key={index}
          data-tile={tile.kind}
          title={tile.kind === "used" ? tile.segment.label : tile.kind === "reserved" ? "Reserved for response" : undefined}
          className="aspect-square rounded-[3px] transition-colors duration-(--motion-large-duration) ease-standard motion-reduce:transition-none"
          style={{
            background: tile.kind === "used" ? tile.segment.fill : tile.kind === "reserved" ? RESERVED_FILL : FREE_COLOR,
          }}
        />
      ))}
    </div>
  );
}

/** "42%"; "<1%" when some context is used but rounds to zero; ">999%" when a model's window is far too small. */
export function contextPercentLabel(percent: number, usedTokens = 0): string {
  if (percent === 0 && usedTokens > 0) return "<1%";
  return percent > 999 ? ">999%" : `${percent}%`;
}

/** Share of the window with one decimal; a nonzero share never reads as 0.0%. */
export function percentOfWindowLabel(tokens: number, contextWindow: number): string {
  if (contextWindow <= 0) return "—";
  const percent = (tokens / contextWindow) * 100;
  return tokens > 0 && percent < 0.05 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** Ten pips, one per 10% of usable context; any usage lights the first. */
export function ContextPips({ percent, warning, used = percent > 0 }: { percent: number; warning: boolean; used?: boolean }) {
  const lit = used ? Math.min(10, Math.max(1, Math.round(percent / 10))) : 0;
  return (
    <span aria-hidden="true" data-lit={lit} className="inline-flex shrink-0 items-center gap-[2px]">
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-2.5 w-[3px] rounded-[1.5px] transition-colors duration-(--motion-duration) ease-standard motion-reduce:transition-none",
            index < lit ? (warning ? "bg-support-warning" : "bg-accent") : "bg-control-active",
          )}
        />
      ))}
    </span>
  );
}
