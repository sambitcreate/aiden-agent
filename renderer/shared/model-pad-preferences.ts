// Model Pad layout, model-picker pins and recent models, persisted in main-process AppSettings.
// Shared by the main process (normalization, provider remap/removal, settings
// patch validation) and the renderer (reading the settings query). Every entry
// is keyed `${providerId}::${modelId}`; anything else is dropped fail-closed.

export type ModelPadPlacementSource = "user" | "benchmark" | "neutral";

export interface ModelPadPlacement {
  /** 0 = fastest pace, 1 = most deliberate. */
  x: number;
  /** 0 = least capable, 1 = most capable. */
  y: number;
  xSource: ModelPadPlacementSource;
  ySource: ModelPadPlacementSource;
}

export type ModelPadPlacements = Record<string, ModelPadPlacement>;

export const MAX_MODEL_PAD_PLACEMENTS = 2_000;
export const MAX_MODEL_PAD_KEY_LENGTH = 1_024;
export const MAX_PINNED_MODELS = 200;
/** Recent models kept in history; the picker shows fewer. */
export const MAX_RECENT_MODELS = 5;

const MODEL_KEY_SEPARATOR = "::";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** A bounded `provider::model` key with a non-empty provider and model. */
function isModelKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_MODEL_PAD_KEY_LENGTH) return false;
  const separator = value.indexOf(MODEL_KEY_SEPARATOR);
  return separator > 0 && separator + MODEL_KEY_SEPARATOR.length < value.length;
}

function coordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function isSource(value: unknown): value is ModelPadPlacementSource {
  return value === "user" || value === "benchmark" || value === "neutral";
}

function placement(value: unknown): ModelPadPlacement | null {
  if (!isRecord(value)) return null;
  const x = coordinate(value.x);
  const y = coordinate(value.y);
  if (x === null || y === null || !isSource(value.xSource) || !isSource(value.ySource)) {
    return null;
  }
  return { x, y, xSource: value.xSource, ySource: value.ySource };
}

/** Keep valid placements only, capped at {@link MAX_MODEL_PAD_PLACEMENTS}. */
export function normalizeModelPadPlacements(value: unknown): ModelPadPlacements | undefined {
  if (!isRecord(value)) return undefined;
  const result: ModelPadPlacements = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_MODEL_PAD_PLACEMENTS) break;
    const next = placement(raw);
    if (!isModelKey(key) || !next) continue;
    result[key] = next;
    count += 1;
  }
  return result;
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

export interface ModelPadPreferencesPatch {
  modelPadPlacements?: ModelPadPlacements;
  pinnedModels?: string[];
  recentModels?: string[];
}

/**
 * Validate the Pad fields of a renderer settings patch. A wrong container or an
 * oversized document is rejected outright (no silent truncation of a user's
 * save); malformed individual entries are dropped.
 */
export function parseModelPadPreferencesPatch(
  patch: Record<string, unknown>,
): ModelPadPreferencesPatch {
  const result: ModelPadPreferencesPatch = {};
  if (patch.modelPadPlacements !== undefined) {
    if (!isRecord(patch.modelPadPlacements)) throw new Error("Invalid Model Pad layout.");
    if (Object.keys(patch.modelPadPlacements).length > MAX_MODEL_PAD_PLACEMENTS) {
      throw new Error(`The Model Pad holds at most ${MAX_MODEL_PAD_PLACEMENTS} models.`);
    }
    result.modelPadPlacements = normalizeModelPadPlacements(patch.modelPadPlacements);
  }
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

/** Re-home placements from a legacy provider id. An existing canonical entry wins. */
export function remapModelPadPlacementsProvider(
  current: ModelPadPlacements | undefined,
  sourceProviderId: string,
  targetProviderId: string,
): ModelPadPlacements | undefined {
  const placements = normalizeModelPadPlacements(current);
  if (!placements || sourceProviderId === targetProviderId) return placements;
  const result: ModelPadPlacements = {};
  for (const [key, value] of Object.entries(placements)) {
    const next = remapKey(key, sourceProviderId, targetProviderId);
    if (next !== key && Object.prototype.hasOwnProperty.call(placements, next)) continue;
    result[next] = value;
  }
  return normalizeModelPadPlacements(result);
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

export function withoutProviderModelPadPlacements(
  current: ModelPadPlacements | undefined,
  providerId: string,
): ModelPadPlacements | undefined {
  const placements = normalizeModelPadPlacements(current);
  if (!placements) return placements;
  return Object.fromEntries(
    Object.entries(placements).filter(([key]) => !belongsTo(key, providerId)),
  );
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
