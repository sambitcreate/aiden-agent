/**
 * Renderer-safe projection of the *next* provider request's context pressure.
 *
 * The main process derives every field from `projectNextContextUsage` using the
 * same options, limits, and compaction threshold as the generation runtime.
 * The renderer never re-estimates context and never reads cumulative Usage
 * totals: this is strictly "what the next request would send".
 */
export interface ChatContextPressureV1 {
  /** Projected total tokens for the next request (static + messages). */
  contextTokens: number;
  /** The selected model's context window. */
  contextWindow: number;
  /** Usable input budget after response + safety reserves. */
  inputBudgetTokens: number;
  /** Tokens reserved for model output and safety margin. */
  reservedTokens: number;
  /** contextTokens / contextWindow, in percent. */
  percentOfWindow: number;
  /** contextTokens / inputBudgetTokens, in percent. */
  percentOfUsableInput: number;
  /** The exact runtime rule: compaction triggers before the next request. */
  shouldCompact: boolean;
  /** Estimated tokens for projected messages only. */
  messageTokens: number;
  /** Estimated tokens for system prompt + tool schemas. */
  staticTokens: number;
  /** Provider-reported usage at the trustworthy anchor, when one exists. */
  providerUsageTokens?: number;
  /** Estimated tokens for messages after the provider usage anchor. */
  addedAfterUsageAnchorTokens?: number;
  /** History messages before the current turn that compaction could remove. */
  compressibleHistoryMessages: number;
  /** Whether the projection leans on a provider usage anchor. */
  source: "provider-anchored" | "estimated";
  /** Epoch ms when main computed this projection. */
  computedAt: number;
}

export type ChatContextPressureSource = ChatContextPressureV1["source"];

function safeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseChatContextPressure(value: unknown): ChatContextPressureV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !safeNonNegative(candidate.contextTokens) ||
    !safeNonNegative(candidate.contextWindow) ||
    candidate.contextWindow < 1 ||
    !safeNonNegative(candidate.inputBudgetTokens) ||
    !safeNonNegative(candidate.reservedTokens) ||
    !safeNonNegative(candidate.percentOfWindow) ||
    !safeNonNegative(candidate.percentOfUsableInput) ||
    typeof candidate.shouldCompact !== "boolean" ||
    !safeNonNegative(candidate.messageTokens) ||
    !safeNonNegative(candidate.staticTokens) ||
    !safeNonNegative(candidate.compressibleHistoryMessages) ||
    !Number.isSafeInteger(candidate.compressibleHistoryMessages) ||
    (candidate.source !== "provider-anchored" && candidate.source !== "estimated") ||
    !safeNonNegative(candidate.computedAt) ||
    (candidate.providerUsageTokens !== undefined &&
      !safeNonNegative(candidate.providerUsageTokens)) ||
    (candidate.addedAfterUsageAnchorTokens !== undefined &&
      !safeNonNegative(candidate.addedAfterUsageAnchorTokens))
  ) {
    return undefined;
  }
  return {
    contextTokens: candidate.contextTokens,
    contextWindow: candidate.contextWindow,
    inputBudgetTokens: candidate.inputBudgetTokens,
    reservedTokens: candidate.reservedTokens,
    percentOfWindow: candidate.percentOfWindow,
    percentOfUsableInput: candidate.percentOfUsableInput,
    shouldCompact: candidate.shouldCompact,
    messageTokens: candidate.messageTokens,
    staticTokens: candidate.staticTokens,
    compressibleHistoryMessages: candidate.compressibleHistoryMessages,
    source: candidate.source,
    computedAt: candidate.computedAt,
    ...(candidate.providerUsageTokens === undefined
      ? {}
      : { providerUsageTokens: candidate.providerUsageTokens }),
    ...(candidate.addedAfterUsageAnchorTokens === undefined
      ? {}
      : { addedAfterUsageAnchorTokens: candidate.addedAfterUsageAnchorTokens }),
  };
}

/** Notification payload for `chat:context-pressure`. */
export interface ChatContextPressureNotification {
  streamId?: string;
  chatId: string;
  pressure: ChatContextPressureV1 | null;
}

export function parseChatContextPressureNotification(
  value: unknown,
): ChatContextPressureNotification | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.chatId !== "string" || candidate.chatId.length === 0) return undefined;
  if (
    candidate.streamId !== undefined &&
    (typeof candidate.streamId !== "string" || !candidate.streamId)
  ) {
    return undefined;
  }
  const streamId = typeof candidate.streamId === "string" ? candidate.streamId : undefined;
  if (candidate.pressure === null) {
    return { chatId: candidate.chatId, pressure: null, ...(streamId ? { streamId } : {}) };
  }
  const pressure = parseChatContextPressure(candidate.pressure);
  if (!pressure) return undefined;
  return { chatId: candidate.chatId, pressure, ...(streamId ? { streamId } : {}) };
}

/**
 * Token counts presented in the composer. Every projected figure is an
 * estimate, so callers prefix `~`; this only produces the compact magnitude.
 */
export function formatContextTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) {
    const millions = rounded / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (rounded >= 1_000) {
    const thousands = rounded / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(rounded);
}

/** Whole-number percentage for labels and screen readers. */
export function contextPressurePercent(pressure: ChatContextPressureV1): number {
  return Math.max(0, Math.round(pressure.percentOfUsableInput));
}
