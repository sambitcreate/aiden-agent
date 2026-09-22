import {
  GENERATION_THINKING_LEVELS,
  isGenerationThinkingLevel,
  type GenerationThinkingLevel,
} from "./generation-thinking";

const MAX_PROVIDERS = 128;
const MAX_MODELS_TOTAL = 512;
const MAX_ID_CHARS = 256;

export type ProviderThinkingPreferences = Record<
  string,
  Record<string, GenerationThinkingLevel>
>;

export function parseProviderThinkingPreferences(value: unknown): ProviderThinkingPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid provider thinking preferences.");
  }
  const providers = Object.entries(value);
  if (providers.length > MAX_PROVIDERS) throw new Error("Too many provider thinking preferences.");
  let total = 0;
  const parsed: ProviderThinkingPreferences = {};
  for (const [providerId, rawModels] of providers) {
    if (!providerId || providerId.length > MAX_ID_CHARS || !rawModels ||
      typeof rawModels !== "object" || Array.isArray(rawModels)) {
      throw new Error("Invalid provider thinking preference.");
    }
    const models: Record<string, GenerationThinkingLevel> = {};
    for (const [modelId, level] of Object.entries(rawModels)) {
      total += 1;
      if (total > MAX_MODELS_TOTAL || !modelId || modelId.length > MAX_ID_CHARS ||
        !isGenerationThinkingLevel(level)) {
        throw new Error("Invalid provider thinking preference.");
      }
      models[modelId] = level;
    }
    if (Object.keys(models).length > 0) parsed[providerId] = models;
  }
  return parsed;
}

export function mergeProviderThinkingPreference(
  current: unknown,
  providerId: string,
  modelId: string,
  level: GenerationThinkingLevel,
): ProviderThinkingPreferences {
  if (!providerId || providerId.length > MAX_ID_CHARS || !modelId || modelId.length > MAX_ID_CHARS) {
    throw new Error("Invalid provider thinking preference.");
  }
  const providerEntries = current && typeof current === "object" && !Array.isArray(current)
    ? Object.entries(current).filter(([id, models]) =>
        Boolean(id) && id.length <= MAX_ID_CHARS && models !== null &&
        typeof models === "object" && !Array.isArray(models),
      )
    : [];
  if (!providerEntries.some(([id]) => id === providerId) && providerEntries.length >= MAX_PROVIDERS) {
    throw new Error("Too many provider thinking preferences.");
  }
  const total = providerEntries.reduce((count, [, models]) =>
    count + Object.keys(models as Record<string, unknown>).length, 0);
  const currentModels = providerEntries.find(([id]) => id === providerId)?.[1] as
    | Record<string, unknown>
    | undefined;
  if (!Object.prototype.hasOwnProperty.call(currentModels ?? {}, modelId) &&
    total >= MAX_MODELS_TOTAL) {
    throw new Error("Too many provider thinking preferences.");
  }
  const retainedProviders = providerEntries.filter(([id]) => id !== providerId);
  const retainedModels = Object.entries(currentModels ?? {}).filter(
    ([id]) => Boolean(id) && id.length <= MAX_ID_CHARS && id !== modelId,
  );
  return Object.fromEntries([
    ...retainedProviders,
    [providerId, Object.fromEntries([...retainedModels, [modelId, level]])],
  ]) as ProviderThinkingPreferences;
}

export function normalizeProviderThinkingLevel(
  levels: readonly GenerationThinkingLevel[],
  value: unknown,
): GenerationThinkingLevel {
  if (isGenerationThinkingLevel(value) && levels.includes(value)) return value;
  for (const preferred of ["medium", "high", "low", "off"] as const) {
    if (levels.includes(preferred)) return preferred;
  }
  return levels[0] ?? GENERATION_THINKING_LEVELS[0];
}
