import type { ModelInfo, Provider } from "./types";
import { resolveModelDisplay } from "./model-display";
import { isLocalProviderDeployment } from "../shared/provider-deployment";
import { isModelHidden, type HiddenModelsByProvider } from "../shared/model-visibility";
import { isNonChatModel } from "../shared/model-eligibility";
import { modelIdLeaf } from "../shared/model-catalog-provider";

const FORMAT_RE = /[\s._-](MLX|GGUF|GGML|FP16|BF16|F16|INT8|AWQ|GPTQ|Q\d(?:_[A-Z0-9]+)*)$/i;

export interface ModelEntry {
  value: string;
  providerId: string;
  model: string;
  label: string;
  format: string | null;
  providerLabel: string;
  providerArtwork?: Provider["artwork"];
  isLocal: boolean;
  info?: ModelInfo;
}

export interface ChatModelProvider {
  provider: Provider;
  models: string[];
}

export interface ExplicitModelSelection {
  providerId: string;
  model: string;
}

export function encodeSelection(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

export function decodeSelection(value: string): { providerId: string; model: string } {
  const idx = value.indexOf("::");
  if (idx < 0) return { providerId: value, model: "" };
  return { providerId: value.slice(0, idx), model: value.slice(idx + 2) };
}

/** A provider is usable once it has models listed and (if required) a key. */
export function isUsable(provider: Provider): boolean {
  return provider.models.length > 0 && (provider.hasKey || !provider.needsKey);
}

export function providerIsLocal(provider: Provider): boolean {
  return isLocalProviderDeployment(provider);
}

/** Split a model id into a display label and an optional quant/format tag. */
export function parseModel(name: string): { label: string; format: string | null } {
  const match = name.match(FORMAT_RE);
  if (!match || match.index === undefined) return { label: name, format: null };
  return {
    label: name.slice(0, match.index).trim() || name,
    format: match[1].toUpperCase(),
  };
}

/** Flattens per-provider catalog answers into the `provider::model` lookup the picker uses. */
export function modelInfoByValue(
  providers: readonly Provider[],
  infoByProvider: Readonly<
    Record<string, Readonly<Record<string, ModelInfo | undefined>> | undefined>
  >,
): Record<string, ModelInfo | undefined> {
  const infoByValue: Record<string, ModelInfo | undefined> = {};
  for (const provider of providers) {
    const data = infoByProvider[provider.id];
    for (const modelId of provider.models) {
      infoByValue[encodeSelection(provider.id, modelId)] = data?.[modelId];
    }
  }
  return infoByValue;
}

export function createModelEntries(
  providers: Provider[],
  infoByValue: Readonly<Record<string, ModelInfo | undefined>> = {},
): ModelEntry[] {
  const orderedProviders = providers
    .filter(isUsable)
    .map((provider, index) => ({ provider, index, local: providerIsLocal(provider) }))
    .sort((a, b) => Number(a.local) - Number(b.local) || a.index - b.index);

  const entries: ModelEntry[] = [];
  for (const { provider, local } of orderedProviders) {
    for (const model of provider.models) {
      const value = encodeSelection(provider.id, model);
      const info = infoByValue[value];
      if (
        isNonChatModel({
          model,
          metadataType: provider.modelMetadata?.[model]?.type,
          catalogType: info?.modelType,
        })
      ) {
        continue;
      }
      const display = resolveModelDisplay(model, info);
      entries.push({
        value,
        providerId: provider.id,
        model,
        label: display.label,
        format: display.format ?? info?.format ?? null,
        providerLabel: provider.label,
        providerArtwork: provider.artwork,
        isLocal: local,
        info,
      });
    }
  }
  return entries;
}

/** Apply the presentation-only model visibility preference to a picker catalog. */
export function visibleModelEntries(
  entries: readonly ModelEntry[],
  hidden: HiddenModelsByProvider | undefined,
): ModelEntry[] {
  return entries.filter((entry) => !isModelHidden(hidden, entry.providerId, entry.model));
}

/**
 * The model behind an entry, independent of the provider that serves it: the last path
 * segment (date stamp kept) of the catalog's canonical id when known, else of the model
 * id, lowercased. Display-only: it links duplicate routes visually and never changes routing.
 */
export function modelIdentityKey(entry: Pick<ModelEntry, "model" | "info">): string {
  return modelIdLeaf(canonicalModelId(entry) ?? entry.model);
}

function canonicalModelId(entry: Pick<ModelEntry, "info">): string | undefined {
  return entry.info?.canonicalModelId?.trim().toLowerCase() || undefined;
}

/** Same identity, from different providers, and never two different canonical ids. */
function isSiblingRoute(entry: ModelEntry, other: ModelEntry): boolean {
  if (other.value === entry.value || other.providerId === entry.providerId) return false;
  const a = canonicalModelId(entry);
  const b = canonicalModelId(other);
  return !(a && b && a !== b);
}

/**
 * Other providers' routes to the same model, keyed by entry value. Pass visible entries
 * only; an entry never links to itself or to another model of its own provider, and
 * entries without a sibling are absent.
 */
export function modelSiblings(entries: readonly ModelEntry[]): Map<string, ModelEntry[]> {
  const groups = new Map<string, ModelEntry[]>();
  for (const entry of entries) {
    const key = modelIdentityKey(entry);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const siblings = new Map<string, ModelEntry[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const others = group.filter((other) => isSiblingRoute(entry, other));
      if (others.length > 0) siblings.set(entry.value, others);
    }
  }
  return siblings;
}

/** "Also via A", "Also via A, B" or "Also via A, B +n" for an entry's sibling routes. */
export function alsoViaLabel(siblings: readonly ModelEntry[] | undefined): string | undefined {
  const providers = alsoViaProviders(siblings);
  return providers ? `Also via ${providers}` : undefined;
}

/** The providers part of {@link alsoViaLabel} ("OpenRouter, Azure +2"), for mid-sentence use. */
export function alsoViaProviders(siblings: readonly ModelEntry[] | undefined): string | undefined {
  const providers = [...new Set((siblings ?? []).map((entry) => entry.providerLabel))];
  if (providers.length === 0) return undefined;
  const named = providers.slice(0, 2).join(", ");
  const rest = providers.length - 2;
  return `${named}${rest > 0 ? ` +${rest}` : ""}`;
}

/** Group only text-generating models while preserving the configured provider order. */
export function createChatModelProviders(
  providers: Provider[],
  infoByProvider: Readonly<
    Record<string, Readonly<Record<string, ModelInfo | undefined>> | undefined>
  > = {},
): ChatModelProvider[] {
  const modelsByProvider = new Map<string, string[]>();
  for (const entry of createModelEntries(providers, modelInfoByValue(providers, infoByProvider))) {
    const models = modelsByProvider.get(entry.providerId) ?? [];
    models.push(entry.model);
    modelsByProvider.set(entry.providerId, models);
  }
  return providers.flatMap((provider) => {
    const models = modelsByProvider.get(provider.id);
    return models?.length ? [{ provider, models }] : [];
  });
}

/** Never reroute a stale nonempty selection to another provider implicitly. */
export function resolveExplicitModelSelection(
  saved: ExplicitModelSelection,
  providers: ChatModelProvider[],
): ExplicitModelSelection {
  const selected = providers.find(({ provider }) => provider.id === saved.providerId);
  if (selected) {
    return selected.models.includes(saved.model)
      ? saved
      : { providerId: selected.provider.id, model: "" };
  }
  if (saved.providerId || saved.model) return { providerId: "", model: "" };
  const first = providers[0];
  if (!first) return { providerId: "", model: "" };
  return {
    providerId: first.provider.id,
    model:
      first.provider.defaultModel && first.models.includes(first.provider.defaultModel)
        ? first.provider.defaultModel
        : (first.models[0] ?? ""),
  };
}

/** Pinned models lead the list, in the order they were pinned. */
export function orderModelEntries(entries: ModelEntry[], pinned: string[]): ModelEntry[] {
  const byValue = new Map(entries.map((entry) => [entry.value, entry]));
  const pinnedEntries = pinned
    .map((value) => byValue.get(value))
    .filter((entry): entry is ModelEntry => Boolean(entry));
  const pinnedSet = new Set(pinnedEntries.map((entry) => entry.value));
  return [...pinnedEntries, ...entries.filter((entry) => !pinnedSet.has(entry.value))];
}

/** Recent rows the picker list shows at most. */
export const MAX_RECENT_MODEL_ROWS = 3;

/**
 * The recent models the list shows: still-visible entries in recency order,
 * excluding the current model and pinned models (they are already prominent),
 * at most {@link MAX_RECENT_MODEL_ROWS}.
 */
export function recentModelsForList(
  entries: readonly ModelEntry[],
  recent: readonly string[],
  { selectedValue, pinned }: { selectedValue: string; pinned: readonly string[] },
): ModelEntry[] {
  const byValue = new Map(entries.map((entry) => [entry.value, entry]));
  const skipped = new Set([selectedValue, ...pinned]);
  const rows: ModelEntry[] = [];
  for (const value of recent) {
    if (rows.length >= MAX_RECENT_MODEL_ROWS) break;
    const entry = byValue.get(value);
    if (!entry || skipped.has(value)) continue;
    rows.push(entry);
    skipped.add(value);
  }
  return rows;
}
