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
  let reserveTokens = configured.reserveTokens ?? 16_384;
  let keepRecentTokens = configured.keepRecentTokens ?? 20_000;
  if (engine === "vcc" || reserveTokens >= model.contextWindow || keepRecentTokens > model.contextWindow - reserveTokens) {
    reserveTokens = Math.min(reserveTokens, Math.floor(model.contextWindow / 4));
    keepRecentTokens = Math.min(keepRecentTokens, Math.floor((model.contextWindow - reserveTokens) / 2));
  }
  return Object.freeze({ reserveTokens, keepRecentTokens });
}
