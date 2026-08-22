export type HiddenModelsByProvider = Record<string, string[]>;

export const MAX_HIDDEN_MODEL_PROVIDERS = 128;
export const MAX_HIDDEN_MODELS_PER_PROVIDER = 512;
export const MAX_HIDDEN_MODELS_TOTAL = 4_096;
export const MAX_MODEL_IDENTITY_LENGTH = 256;

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MODEL_IDENTITY_LENGTH &&
    value.trim() === value
  );
}

export function normalizeHiddenModelsByProvider(
  value: unknown,
): HiddenModelsByProvider | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: HiddenModelsByProvider = {};
  let total = 0;
  for (const [providerId, rawModels] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_HIDDEN_MODEL_PROVIDERS) break;
    if (!validIdentity(providerId) || !Array.isArray(rawModels)) continue;
    const models = [...new Set(rawModels.filter(validIdentity))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, Math.min(MAX_HIDDEN_MODELS_PER_PROVIDER, MAX_HIDDEN_MODELS_TOTAL - total));
    if (models.length === 0) continue;
    result[providerId] = models;
    total += models.length;
    if (total >= MAX_HIDDEN_MODELS_TOTAL) break;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function isModelHidden(
  hidden: HiddenModelsByProvider | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return hidden?.[providerId]?.includes(modelId) === true;
}

/** Resolve a default for newly-created work without making hidden models unexecutable. */
export function firstVisibleModelForProvider(
  hidden: HiddenModelsByProvider | undefined,
  providerId: string,
  modelIds: readonly string[],
  preferredModelIds: readonly (string | undefined)[] = [],
): string | undefined {
  const visible = modelIds.filter((modelId) => !isModelHidden(hidden, providerId, modelId));
  for (const preferred of preferredModelIds) {
    if (preferred && visible.includes(preferred)) return preferred;
  }
  return visible[0];
}

export function withModelVisibility(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
  modelId: string,
  hidden: boolean,
): HiddenModelsByProvider | undefined {
  if (!validIdentity(providerId) || !validIdentity(modelId)) {
    throw new Error("Invalid provider or model identity.");
  }
  const next = normalizeHiddenModelsByProvider(current) ?? {};
  const models = new Set(next[providerId] ?? []);
  if (hidden) models.add(modelId);
  else models.delete(modelId);
  const candidate = { ...next };
  if (models.size > 0) candidate[providerId] = [...models];
  else delete candidate[providerId];
  return normalizeHiddenModelsByProvider(candidate);
}

export function withoutProviderVisibility(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
): HiddenModelsByProvider | undefined {
  const next = normalizeHiddenModelsByProvider(current);
  if (!next || !Object.prototype.hasOwnProperty.call(next, providerId)) return next;
  delete next[providerId];
  return normalizeHiddenModelsByProvider(next);
}

export function remapHiddenModelProvider(
  current: HiddenModelsByProvider | undefined,
  sourceProviderId: string,
  targetProviderId: string,
): HiddenModelsByProvider | undefined {
  const next = normalizeHiddenModelsByProvider(current);
  if (!next || sourceProviderId === targetProviderId || !next[sourceProviderId]) return next;
  next[targetProviderId] = [...(next[targetProviderId] ?? []), ...next[sourceProviderId]];
  delete next[sourceProviderId];
  return normalizeHiddenModelsByProvider(next);
}
