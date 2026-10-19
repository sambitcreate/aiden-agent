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
  /** Where `staticTokens` comes from, per category, plus tools held back from the request. */
  breakdown?: ContextBreakdownV1;
  /**
   * The provider's prompt cache for this chat: present only when the model
   * declares a cache lifetime and a request has used the cache.
   */
  promptCache?: PromptCacheWindowV1;
}

export interface PromptCacheWindowV1 {
  /** How long the provider keeps an unused prompt cache, in ms. */
  ttlMs: number;
  /** Epoch ms of the last request that read or wrote the cache. */
  lastRequestAt: number;
}

export const CONTEXT_CATEGORY_IDS = [
  "system-prompt",
  "builtin-tools",
  "mcp-tools",
  "skills",
  "memory",
  "project-instructions",
  "mcp-instructions",
  "bot-instructions",
] as const;

export type ContextCategoryId = (typeof CONTEXT_CATEGORY_IDS)[number];

export interface ContextBreakdownCategory {
  id: ContextCategoryId;
  tokens: number;
}

export interface DeferredContextServer {
  name: string;
  count: number;
  tokens: number;
}

export interface DeferredContextCategory {
  id: "mcp-tools";
  tokens: number;
  count: number;
  servers: DeferredContextServer[];
}

export interface ContextBreakdownV1 {
  /** Static categories; tokens sum exactly to staticTokens. Zero-token categories are omitted. */
  categories: ContextBreakdownCategory[];
  /** Tools held back behind tool search; not counted in contextTokens. */
  deferred: DeferredContextCategory[];
}

export type ChatContextPressureSource = ChatContextPressureV1["source"];

function safeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const CONTEXT_CATEGORY_ID_SET: ReadonlySet<string> = new Set(CONTEXT_CATEGORY_IDS);

function parseDeferredCategory(value: unknown): DeferredContextCategory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.id !== "mcp-tools" ||
    !nonNegativeInteger(candidate.tokens) ||
    !positiveInteger(candidate.count) ||
    !Array.isArray(candidate.servers) ||
    candidate.servers.length === 0
  ) {
    return undefined;
  }
  const servers: DeferredContextServer[] = [];
  let count = 0;
  let tokens = 0;
  for (const entry of candidate.servers as unknown[]) {
    if (!entry || typeof entry !== "object") return undefined;
    const server = entry as Record<string, unknown>;
    if (
      typeof server.name !== "string" ||
      !server.name.trim() ||
      !positiveInteger(server.count) ||
      !nonNegativeInteger(server.tokens)
    ) {
      return undefined;
    }
    servers.push({ name: server.name, count: server.count, tokens: server.tokens });
    count += server.count;
    tokens += server.tokens;
  }
  if (count !== candidate.count || tokens !== candidate.tokens) return undefined;
  return { id: "mcp-tools", tokens: candidate.tokens, count: candidate.count, servers };
}

/**
 * A breakdown is all-or-nothing: any malformed entry, a repeated category, or
 * categories that do not add up to `staticTokens` drops the whole breakdown.
 */
function parseContextBreakdown(
  value: unknown,
  staticTokens: number,
): ContextBreakdownV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.categories) || !Array.isArray(candidate.deferred)) return undefined;
  const categories: ContextBreakdownCategory[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const entry of candidate.categories as unknown[]) {
    if (!entry || typeof entry !== "object") return undefined;
    const category = entry as Record<string, unknown>;
    if (
      typeof category.id !== "string" ||
      !CONTEXT_CATEGORY_ID_SET.has(category.id) ||
      seen.has(category.id) ||
      !positiveInteger(category.tokens)
    ) {
      return undefined;
    }
    seen.add(category.id);
    categories.push({ id: category.id as ContextCategoryId, tokens: category.tokens });
    sum += category.tokens;
  }
  if (sum !== staticTokens) return undefined;
  const deferred: DeferredContextCategory[] = [];
  for (const entry of candidate.deferred as unknown[]) {
    const parsed = parseDeferredCategory(entry);
    if (!parsed || deferred.some((existing) => existing.id === parsed.id)) return undefined;
    deferred.push(parsed);
  }
  return { categories, deferred };
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
  const promptCache = parsePromptCacheWindow(candidate.promptCache);
  const breakdown =
    candidate.breakdown === undefined
      ? undefined
      : parseContextBreakdown(candidate.breakdown, candidate.staticTokens);
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
    ...(breakdown ? { breakdown } : {}),
    ...(promptCache ? { promptCache } : {}),
  };
}

/** A malformed cache window is dropped rather than failing the whole projection. */
function parsePromptCacheWindow(value: unknown): PromptCacheWindowV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!safeNonNegative(candidate.ttlMs) || candidate.ttlMs === 0 || !safeNonNegative(candidate.lastRequestAt)) {
    return undefined;
  }
  return { ttlMs: candidate.ttlMs, lastRequestAt: candidate.lastRequestAt };
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
  // One decimal, dropping a trailing ".0"; 999,950 rounds up to "1M", never "1000.0K".
  const scaled = (amount: number, unit: string) => `${amount.toFixed(1).replace(/\.0$/u, "")}${unit}`;
  if (rounded >= 999_950) return scaled(rounded / 1_000_000, "M");
  if (rounded >= 1_000) return scaled(rounded / 1_000, "K");
  return String(rounded);
}

/** Whole-number percentage for labels and screen readers. */
export function contextPressurePercent(pressure: ChatContextPressureV1): number {
  return Math.max(0, Math.round(pressure.percentOfUsableInput));
}
