// Model-list pins and recent models, persisted in main-process AppSettings
// (machine-local settings.json). Shared by the main process (normalization,
// provider remap/removal, settings patch validation) and the renderer
// (reading the settings query). Every entry is keyed `${providerId}::${modelId}`;
// anything else is dropped fail-closed.

export const MAX_MODEL_KEY_LENGTH = 1_024;
export const MAX_PINNED_MODELS = 200;
/** Recent models kept in history; the picker shows fewer. */
export const MAX_RECENT_MODELS = 5;

const MODEL_KEY_SEPARATOR = "::";

/** A bounded `provider::model` key with a non-empty provider and model. */
function isModelKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_MODEL_KEY_LENGTH) return false;
  const separator = value.indexOf(MODEL_KEY_SEPARATOR);
  return separator > 0 && separator + MODEL_KEY_SEPARATOR.length < value.length;
}

/** Keep distinct valid pins in order, capped at {@link MAX_PINNED_MODELS}. */
export function normalizePinnedModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isModelKey))].slice(0, MAX_PINNED_MODELS);
}

/** Keep distinct valid recent models, newest first, capped at {@link MAX_RECENT_MODELS}. */
export function normalizeRecentModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isModelKey))].slice(0, MAX_RECENT_MODELS);
}

/** Put `value` first in the recent-model history, dropping its older entry and the oldest overflow. */
export function recordRecentModel(recent: readonly string[], value: string): string[] {
  const history = normalizeRecentModels(recent) ?? [];
  if (!isModelKey(value)) return history;
  return normalizeRecentModels([value, ...history]) ?? [];
}

export interface ModelPreferencesPatch {
  pinnedModels?: string[];
  recentModels?: string[];
}

/**
 * Validate the pin and recent-model fields of a renderer settings patch. A
 * wrong container or an oversized list is rejected outright (no silent
 * truncation of a user's save); malformed individual entries are dropped.
 */
export function parseModelPreferencesPatch(patch: Record<string, unknown>): ModelPreferencesPatch {
  const result: ModelPreferencesPatch = {};
  if (patch.pinnedModels !== undefined) {
    if (!Array.isArray(patch.pinnedModels)) throw new Error("Invalid pinned models.");
    if (patch.pinnedModels.length > MAX_PINNED_MODELS) {
      throw new Error(`At most ${MAX_PINNED_MODELS} models can be pinned.`);
    }
    result.pinnedModels = normalizePinnedModels(patch.pinnedModels);
  }
  if (patch.recentModels !== undefined) {
    if (!Array.isArray(patch.recentModels)) throw new Error("Invalid recent models.");
    if (patch.recentModels.length > MAX_RECENT_MODELS) {
      throw new Error(`At most ${MAX_RECENT_MODELS} recent models are kept.`);
    }
    result.recentModels = normalizeRecentModels(patch.recentModels);
  }
  return result;
}

function remapKey(key: string, sourceProviderId: string, targetProviderId: string): string {
  const prefix = `${sourceProviderId}${MODEL_KEY_SEPARATOR}`;
  return key.startsWith(prefix)
    ? `${targetProviderId}${MODEL_KEY_SEPARATOR}${key.slice(prefix.length)}`
    : key;
}

function belongsTo(key: string, providerId: string): boolean {
  return key.startsWith(`${providerId}${MODEL_KEY_SEPARATOR}`);
}

/** Re-home an ordered model-key list; an existing canonical entry keeps its slot. */
function remapModelKeyList(
  normalize: (value: unknown) => string[] | undefined,
  current: readonly string[] | undefined,
  sourceProviderId: string,
  targetProviderId: string,
): string[] | undefined {
  const keys = normalize(current);
  if (!keys || sourceProviderId === targetProviderId) return keys;
  const existing = new Set(keys);
  return normalize(
    keys.flatMap((key) => {
      const next = remapKey(key, sourceProviderId, targetProviderId);
      return next !== key && existing.has(next) ? [] : [next];
    }),
  );
}

/** Re-home pins from a legacy provider id. An existing canonical pin keeps its slot. */
export function remapPinnedModelsProvider(
  current: readonly string[] | undefined,
  sourceProviderId: string,
  targetProviderId: string,
): string[] | undefined {
  return remapModelKeyList(normalizePinnedModels, current, sourceProviderId, targetProviderId);
}

/** Re-home recent models from a legacy provider id. An existing canonical entry keeps its slot. */
export function remapRecentModelsProvider(
  current: readonly string[] | undefined,
  sourceProviderId: string,
  targetProviderId: string,
): string[] | undefined {
  return remapModelKeyList(normalizeRecentModels, current, sourceProviderId, targetProviderId);
}

export function withoutProviderPinnedModels(
  current: readonly string[] | undefined,
  providerId: string,
): string[] | undefined {
  return normalizePinnedModels(current)?.filter((key) => !belongsTo(key, providerId));
}

export function withoutProviderRecentModels(
  current: readonly string[] | undefined,
  providerId: string,
): string[] | undefined {
  return normalizeRecentModels(current)?.filter((key) => !belongsTo(key, providerId));
}
