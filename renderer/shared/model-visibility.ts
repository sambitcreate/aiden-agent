export interface ProviderModelVisibilityRule {
  defaultVisibility: "shown" | "hidden";
  /** Hidden IDs when the default is shown; shown IDs when the default is hidden. */
  exceptions: string[];
  /** System policy gate. Currently used only by Google transcription-only mode. */
  policyHidden?: true;
}

export type HiddenModelsByProvider = Record<string, ProviderModelVisibilityRule | string[]>;
export type NormalizedHiddenModelsByProvider = Record<string, ProviderModelVisibilityRule>;

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

function normalizedExceptions(value: unknown, remaining: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validIdentity))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, Math.min(MAX_HIDDEN_MODELS_PER_PROVIDER, remaining));
}

/** Normalize the canonical document and migrate legacy string arrays. */
export function normalizeHiddenModelsByProvider(
  value: unknown,
): NormalizedHiddenModelsByProvider | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: NormalizedHiddenModelsByProvider = {};
  let total = 0;
  for (const [providerId, rawRule] of Object.entries(value)) {
    if (Object.keys(result).length >= MAX_HIDDEN_MODEL_PROVIDERS) break;
    if (!validIdentity(providerId)) continue;

    let defaultVisibility: ProviderModelVisibilityRule["defaultVisibility"] = "shown";
    let policyHidden = false;
    let rawExceptions: unknown = [];
    if (Array.isArray(rawRule)) {
      const legacy = rawRule.filter(validIdentity);
      const wildcard = legacy.includes("*");
      policyHidden = wildcard && providerId === "google";
      defaultVisibility = wildcard && providerId !== "google" ? "hidden" : "shown";
      rawExceptions = wildcard && providerId !== "google" ? [] : legacy.filter((id) => id !== "*");
    } else if (rawRule && typeof rawRule === "object") {
      const candidate = rawRule as Record<string, unknown>;
      if (candidate.defaultVisibility !== "shown" && candidate.defaultVisibility !== "hidden") {
        continue;
      }
      defaultVisibility = candidate.defaultVisibility;
      rawExceptions = candidate.exceptions;
      policyHidden = candidate.policyHidden === true;
    } else {
      continue;
    }

    const exceptions = normalizedExceptions(rawExceptions, MAX_HIDDEN_MODELS_TOTAL - total);
    if (defaultVisibility === "shown" && exceptions.length === 0 && !policyHidden) continue;
    result[providerId] = {
      defaultVisibility,
      exceptions,
      ...(policyHidden ? { policyHidden: true } : {}),
    };
    total += exceptions.length;
    if (total >= MAX_HIDDEN_MODELS_TOTAL) break;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizedRule(
  current: NormalizedHiddenModelsByProvider | undefined,
  providerId: string,
): ProviderModelVisibilityRule {
  return current?.[providerId] ?? { defaultVisibility: "shown", exceptions: [] };
}

function writeRule(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
  rule: ProviderModelVisibilityRule,
): HiddenModelsByProvider | undefined {
  const next = normalizeHiddenModelsByProvider(current) ?? {};
  const candidate = { ...next };
  if (rule.defaultVisibility === "shown" && rule.exceptions.length === 0 && !rule.policyHidden) {
    delete candidate[providerId];
  } else {
    candidate[providerId] = rule;
  }
  return normalizeHiddenModelsByProvider(candidate);
}

export function isModelHidden(
  hidden: HiddenModelsByProvider | undefined,
  providerId: string,
  modelId: string,
): boolean {
  const rule = hidden?.[providerId];
  if (!rule) return false;
  if (Array.isArray(rule)) {
    return rule.includes("*") || rule.includes(modelId);
  }
  if (rule.policyHidden) return true;
  const exception = rule.exceptions.includes(modelId);
  return rule.defaultVisibility === "hidden" ? !exception : exception;
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
  if (!validIdentity(providerId) || !validIdentity(modelId) || modelId === "*") {
    throw new Error("Invalid provider or model identity.");
  }
  const normalized = normalizeHiddenModelsByProvider(current);
  const rule = normalizedRule(normalized, providerId);
  const exceptions = new Set(rule.exceptions);
  const shouldBeException = rule.defaultVisibility === "hidden" ? !hidden : hidden;
  if (shouldBeException) exceptions.add(modelId);
  else exceptions.delete(modelId);
  return writeRule(normalized, providerId, { ...rule, exceptions: [...exceptions] });
}

export function hideAllProviderModels(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
): HiddenModelsByProvider | undefined {
  if (!validIdentity(providerId)) throw new Error("Invalid provider identity.");
  const normalized = normalizeHiddenModelsByProvider(current);
  const rule = normalizedRule(normalized, providerId);
  return writeRule(normalized, providerId, {
    defaultVisibility: "hidden",
    exceptions: [],
    ...(rule.policyHidden ? { policyHidden: true } : {}),
  });
}

export function withProviderPolicyHidden(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
  policyHidden: boolean,
): HiddenModelsByProvider | undefined {
  if (!validIdentity(providerId)) throw new Error("Invalid provider identity.");
  const normalized = normalizeHiddenModelsByProvider(current);
  const rule = normalizedRule(normalized, providerId);
  return writeRule(normalized, providerId, {
    defaultVisibility: rule.defaultVisibility,
    exceptions: rule.exceptions,
    ...(policyHidden ? { policyHidden: true } : {}),
  });
}

/** Remove every visibility and system-policy record for a deleted provider. */
export function withoutProviderVisibility(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
): HiddenModelsByProvider | undefined {
  const next = normalizeHiddenModelsByProvider(current);
  if (!next || !Object.prototype.hasOwnProperty.call(next, providerId)) return next;
  delete next[providerId];
  return normalizeHiddenModelsByProvider(next);
}

function unionRules(
  left: ProviderModelVisibilityRule,
  right: ProviderModelVisibilityRule,
): ProviderModelVisibilityRule {
  const leftSet = new Set(left.exceptions);
  const rightSet = new Set(right.exceptions);
  let defaultVisibility: ProviderModelVisibilityRule["defaultVisibility"];
  let exceptions: string[];
  if (left.defaultVisibility === "shown" && right.defaultVisibility === "shown") {
    defaultVisibility = "shown";
    exceptions = [...new Set([...leftSet, ...rightSet])];
  } else if (left.defaultVisibility === "hidden" && right.defaultVisibility === "hidden") {
    defaultVisibility = "hidden";
    exceptions = [...leftSet].filter((id) => rightSet.has(id));
  } else {
    const hiddenDefault = left.defaultVisibility === "hidden" ? left : right;
    const shownDefault = left.defaultVisibility === "shown" ? left : right;
    const explicitlyHidden = new Set(shownDefault.exceptions);
    defaultVisibility = "hidden";
    exceptions = hiddenDefault.exceptions.filter((id) => !explicitlyHidden.has(id));
  }
  return {
    defaultVisibility,
    exceptions,
    ...(left.policyHidden || right.policyHidden ? { policyHidden: true } : {}),
  };
}

export function remapHiddenModelProvider(
  current: HiddenModelsByProvider | undefined,
  sourceProviderId: string,
  targetProviderId: string,
): HiddenModelsByProvider | undefined {
  const next = normalizeHiddenModelsByProvider(current);
  if (!next || sourceProviderId === targetProviderId || !next[sourceProviderId]) return next;
  next[targetProviderId] = next[targetProviderId]
    ? unionRules(next[sourceProviderId], next[targetProviderId])
    : next[sourceProviderId];
  delete next[sourceProviderId];
  return normalizeHiddenModelsByProvider(next);
}
