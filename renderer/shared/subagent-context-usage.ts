import { formatContextTokenCount } from "./context-pressure.js";
import { isSafeSubagentIdentifier } from "./subagent-runs.js";

/**
 * Live context-window occupancy for one running child agent.
 *
 * This is deliberately a side channel, not a field on the durable run
 * snapshot: provider usage arrives once per child response, while durable
 * snapshot writes are bounded. Keeping it out of the snapshot means it never
 * reaches the run store, history reads, or the Aiden Remote roster, and it
 * never bumps a snapshot revision.
 */
export interface SubagentContextUsageV1 {
  /** Tokens the child's last provider response reported for its context. */
  tokens: number;
  /** The child model's context window. */
  window: number;
}

/** Notification payload for `chat:subagent-context`. */
export interface SubagentContextUsageNotification {
  streamId: string;
  chatId: string;
  runId: string;
  usage: SubagentContextUsageV1;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Build the reading from the child's latest provider-reported token total,
 * the same figure Pi uses as a response's context size. Returns undefined when
 * the model has no known window or the provider reported nothing.
 */
export function subagentContextUsageFromReport(
  reportedTotal: number,
  contextWindow: number | undefined,
): SubagentContextUsageV1 | undefined {
  if (
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow < 1 ||
    !Number.isFinite(reportedTotal) ||
    reportedTotal <= 0
  ) {
    return undefined;
  }
  return {
    tokens: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(reportedTotal)),
    window: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(contextWindow)),
  };
}

export function parseSubagentContextUsage(value: unknown): SubagentContextUsageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!nonNegativeInteger(candidate.tokens) || !nonNegativeInteger(candidate.window)) {
    return undefined;
  }
  if (candidate.window < 1) return undefined;
  return { tokens: candidate.tokens, window: candidate.window };
}

export function parseSubagentContextUsageNotification(
  value: unknown,
): SubagentContextUsageNotification | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.streamId !== "string" ||
    candidate.streamId.length === 0 ||
    typeof candidate.chatId !== "string" ||
    candidate.chatId.length === 0 ||
    !isSafeSubagentIdentifier(candidate.runId)
  ) {
    return undefined;
  }
  const usage = parseSubagentContextUsage(candidate.usage);
  if (!usage) return undefined;
  return {
    streamId: candidate.streamId,
    chatId: candidate.chatId,
    runId: candidate.runId,
    usage,
  };
}

/** Whole-number share of the window, matching the composer meter's rounding. */
export function subagentContextPercent(usage: SubagentContextUsageV1): number {
  return Math.max(0, Math.round((usage.tokens / usage.window) * 100));
}

/** Presentation threshold shared with the composer meter's "approaching" phase. */
export function subagentContextIsApproachingLimit(usage: SubagentContextUsageV1): boolean {
  return subagentContextPercent(usage) >= 80;
}

export interface SubagentContextUsageLabels {
  /** Compact trailing figure, e.g. `42%`. */
  percent: string;
  /** Used / limit, e.g. `84K / 200K tokens`. */
  amount: string;
  /** Full sentence for screen readers and tooltips. */
  spoken: string;
}

export function subagentContextUsageLabels(
  usage: SubagentContextUsageV1,
): SubagentContextUsageLabels {
  const percent = subagentContextPercent(usage);
  const used = formatContextTokenCount(usage.tokens);
  const limit = formatContextTokenCount(usage.window);
  return {
    percent: `${percent}%`,
    amount: `${used} / ${limit} tokens`,
    spoken: `context ${percent} percent, ${used} of ${limit} tokens`,
  };
}
