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
// Hide all lists every model a provider has, so the ceilings fit the largest
// built-in catalogs (OpenRouter lists about 420 chat models) with room to grow.
export const MAX_HIDDEN_MODELS_PER_PROVIDER = 2_048;
export const MAX_HIDDEN_MODELS_TOTAL = 16_384;
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

/** Hidden ids other providers' rules already hold, toward the total ceiling. */
function exceptionsOutside(
  rules: NormalizedHiddenModelsByProvider | undefined,
  providerId: string,
): number {
  return Object.entries(rules ?? {}).reduce(
    (total, [id, rule]) => (id === providerId ? total : total + rule.exceptions.length),
    0,
  );
}

/**
 * A rule that hides exactly `modelIds` and lets every other model show, so a
 * model the provider adds later starts visible. Undefined when the list can't
 * fit under the ceilings.
 */
function hiddenListRule(
  rules: NormalizedHiddenModelsByProvider | undefined,
  providerId: string,
  modelIds: Iterable<string>,
  policyHidden: boolean | undefined,
): ProviderModelVisibilityRule | undefined {
  const exceptions = [...new Set([...modelIds].filter((id) => validIdentity(id) && id !== "*"))];
  if (
    exceptions.length > MAX_HIDDEN_MODELS_PER_PROVIDER ||
    exceptions.length + exceptionsOutside(rules, providerId) > MAX_HIDDEN_MODELS_TOTAL
  ) {
    return undefined;
  }
  return { defaultVisibility: "shown", exceptions, ...(policyHidden ? { policyHidden: true } : {}) };
}

/**
 * Hide every model the provider lists now (`modelIds`). Models it adds later
 * start shown, so a new release is never hidden by an older choice. A catalog
 * too large to list under the ceilings falls back to hiding by default, which
 * hides later models too.
 */
export function hideAllProviderModels(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
  modelIds: readonly string[],
): HiddenModelsByProvider | undefined {
  if (!validIdentity(providerId)) throw new Error("Invalid provider identity.");
  const normalized = normalizeHiddenModelsByProvider(current);
  const rule = normalizedRule(normalized, providerId);
  return writeRule(
    normalized,
    providerId,
    hiddenListRule(normalized, providerId, modelIds, rule.policyHidden) ?? {
      defaultVisibility: "hidden",
      exceptions: [],
      ...(rule.policyHidden ? { policyHidden: true } : {}),
    },
  );
}

/**
 * Turn each "hidden by default" rule (an earlier Hide all) into a list of the
 * models it hides today, given each provider's current models. Every model
 * that is hidden now stays hidden, and models the provider adds later show.
 * A provider missing from `modelsByProvider`, or too large to list, keeps its
 * rule. Returns undefined when nothing changes.
 */
export function revealFutureProviderModels(
  current: HiddenModelsByProvider | undefined,
  modelsByProvider: ReadonlyMap<string, readonly string[]>,
): HiddenModelsByProvider | undefined {
  let next = normalizeHiddenModelsByProvider(current);
  let changed = false;
  for (const [providerId, rule] of Object.entries(next ?? {})) {
    const models = modelsByProvider.get(providerId);
    // An empty list (a provider whose models aren't loaded yet) can't say
    // what the rule hides today, so it keeps the rule until a later launch.
    if (rule.defaultVisibility !== "hidden" || !models?.length) continue;
    const shown = new Set(rule.exceptions);
    const listed = hiddenListRule(
      next,
      providerId,
      models.filter((id) => !shown.has(id)),
      rule.policyHidden,
    );
    if (!listed) continue;
    next = writeRule(next, providerId, listed) as NormalizedHiddenModelsByProvider | undefined;
    changed = true;
  }
  return changed ? next : undefined;
}

/** True while any provider still hides models it adds later. */
export function hidesFutureModels(current: HiddenModelsByProvider | undefined): boolean {
  return Object.values(normalizeHiddenModelsByProvider(current) ?? {}).some(
    (rule) => rule.defaultVisibility === "hidden",
  );
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
