/** One automatic preference; commands may override it for one operation. */
export type CompactionEngine = "llm" | "vcc";

export function isCompactionEngine(value: unknown): value is CompactionEngine {
  return value === "llm" || value === "vcc";
}

export function compactionEngineFrom(value: unknown): CompactionEngine {
  return isCompactionEngine(value) ? value : "llm";
}

export function compactionEngineLabel(engine: CompactionEngine): string {
  return engine === "vcc" ? "pi-vcc" : "LLM";
}

/**
 * Pi's `DEFAULT_COMPACTION_SETTINGS` pair, used when an override sets only one
 * field. The renderer cannot import pi, so pi-compaction-core.test.ts checks
 * these against pi's values.
 */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

export interface CompactionModelBudget {
  reserveTokens?: number;
  keepRecentTokens?: number;
}

/** Exact provider/model keys; overrides never follow similarly named models. */
export type CompactionModelOverrides = Readonly<Record<string, Readonly<CompactionModelBudget>>>;

export function parseCompactionModelOverrides(value: unknown): CompactionModelOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 256) {
    throw new Error("Model compaction budgets must be an object with at most 256 models.");
  }
  const entries = Object.entries(value).map(([key, raw]) => {
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1 || key.length > 512 || key !== key.trim() || Array.from(key).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error("Choose an exact provider/model for the compaction budget.");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid model compaction budget.");
    const budget: CompactionModelBudget = {};
    for (const [field, tokens] of Object.entries(raw)) {
      if (field !== "reserveTokens" && field !== "keepRecentTokens") throw new Error("Unknown compaction budget field.");
      if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < (field === "reserveTokens" ? 2 : 0) || tokens > 10_000_000) {
        throw new Error("Compaction token budgets must be whole numbers (reserve: 2–10000000; recent: 0–10000000).");
      }
      budget[field] = tokens;
    }
    return [key, Object.freeze(budget)] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

/** Resolve and bound a configured pair without changing unconfigured defaults. */
export function resolveCompactionModelBudget(
  overrides: CompactionModelOverrides | undefined,
  model: { provider: string; id: string; contextWindow: number },
  engine: CompactionEngine = "llm",
): Required<CompactionModelBudget> | undefined {
  const key = `${model.provider}/${model.id}`;
  const configured = overrides && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
  if (!configured || (configured.reserveTokens === undefined && configured.keepRecentTokens === undefined)) return undefined;
  let reserveTokens = configured.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
  let keepRecentTokens = configured.keepRecentTokens ?? DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;
  if (engine === "vcc" || reserveTokens >= model.contextWindow || keepRecentTokens > model.contextWindow - reserveTokens) {
    reserveTokens = Math.min(reserveTokens, Math.floor(model.contextWindow / 4));
    keepRecentTokens = Math.min(keepRecentTokens, Math.floor((model.contextWindow - reserveTokens) / 2));
  }
  return Object.freeze({ reserveTokens, keepRecentTokens });
}

/**
 * The request reserve to apply to a model's input budget: the bounded reserve
 * only when the user set `reserveTokens` for it. An override of recent tokens
 * alone leaves the model-derived reserve unchanged rather than substituting
 * pi's default, which would shrink the input budget of small-window models.
 */
export function configuredCompactionReserveTokens(
  overrides: CompactionModelOverrides | undefined,
  model: { provider: string; id: string; contextWindow: number },
  engine: CompactionEngine = "llm",
): number | undefined {
  const key = `${model.provider}/${model.id}`;
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, key) || overrides[key]?.reserveTokens === undefined) return undefined;
  return resolveCompactionModelBudget(overrides, model, engine)?.reserveTokens;
}
