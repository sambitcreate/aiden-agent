import type { ModelBenchmarkMetric, ModelInfo, ModelRanking, Provider } from "./types";
import { resolveModelDisplay } from "./model-display";
import {
  modelPadGridPoints,
  modelPadGridSize,
  reflowVisibleModelPadPlacements,
  type ModelPadPlacement,
} from "./model-pad-layout";
import { isLocalProviderDeployment } from "../shared/provider-deployment";
import { isModelHidden, type HiddenModelsByProvider } from "../shared/model-visibility";
import { isNonChatModel } from "../shared/model-eligibility";

export type { ModelRanking } from "./types";

export const PINNED_MODELS_KEY = "aiden-agent.pinnedModels";
export { BASE_MODEL_PAD_GRID_SIZE as BASE_MODEL_GRID_SIZE } from "./model-pad-layout";
export { modelPadGridSize as modelGridSize } from "./model-pad-layout";

const FORMAT_RE = /[\s._-](MLX|GGUF|GGML|FP16|BF16|F16|INT8|AWQ|GPTQ|Q\d(?:_[A-Z0-9]+)*)$/i;
const FAST_VARIANT_RE =
  /(?:^|[\s._/-])(nano|tiny|mini|small|haiku|flash|lite|instant)(?:$|[\s._/-])/i;
const DEEP_VARIANT_RE =
  /(?:^|[\s._/-])(reasoner|reasoning|thinking|think|deep|high|xhigh)(?:$|[\s._/-])/i;
const CAPABLE_VARIANT_RE = /(?:^|[\s._/-])(sonnet|opus|pro|ultra|max|large)(?:$|[\s._/-])/i;
const PARAMETER_COUNT_RE = /(?:^|[\s._/-])(\d+(?:\.\d+)?)b(?:$|[\s._/-])/i;

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
  ranking?: ModelRanking;
}

/** Return benchmark-score percentiles with average ranks for ties. */
export function modelBenchmarkPercentiles(
  entries: readonly ModelEntry[],
  metric: ModelBenchmarkMetric,
): Map<string, number> {
  const rows: Array<{ id: string; value: number }> = [];
  for (const entry of entries) {
    const value = entry.info?.benchmark?.[metric];
    if (typeof value === "number" && Number.isFinite(value)) {
      rows.push({ id: entry.value, value });
    }
  }
  rows.sort((left, right) => left.value - right.value || left.id.localeCompare(right.id));
  const result = new Map<string, number>();
  if (rows.length === 1) result.set(rows[0].id, 0.5);
  for (let start = 0; rows.length > 1 && start < rows.length; ) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1].value === rows[start].value) end += 1;
    const percentile = (start + end) / 2 / (rows.length - 1);
    for (let index = start; index <= end; index += 1) result.set(rows[index].id, percentile);
    start = end + 1;
  }
  return result;
}

export interface ChatModelProvider {
  provider: Provider;
  models: string[];
}

export interface ExplicitModelSelection {
  providerId: string;
  model: string;
}

export type PositionConfidence = "personal" | "suggested" | "benchmark" | "estimated" | "unranked";

export interface PositionedModel extends ModelEntry {
  /** Left (fast) to right (more deliberate), normalized to 0...1. */
  x: number;
  /** Bottom (everyday) to top (more capable), normalized to 0...1. */
  y: number;
  confidence: PositionConfidence;
  positionSource: string;
  capabilityLabel: "Everyday" | "Capable" | "Advanced";
  paceLabel: "Faster" | "Balanced" | "Deliberate";
}

export interface ModelPoint {
  x: number;
  y: number;
}

export type ModelDirection = "left" | "right" | "up" | "down";

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

export function createModelEntries(
  providers: Provider[],
  infoByValue: Readonly<Record<string, ModelInfo | undefined>> = {},
  rankingsByValue: Readonly<Record<string, ModelRanking | undefined>> = {},
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
        ranking: rankingsByValue[value] ?? info?.ranking,
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

/** Group only text-generating models while preserving the configured provider order. */
export function createChatModelProviders(
  providers: Provider[],
  infoByProvider: Readonly<
    Record<string, Readonly<Record<string, ModelInfo | undefined>> | undefined>
  > = {},
): ChatModelProvider[] {
  const infoByValue: Record<string, ModelInfo | undefined> = {};
  for (const provider of providers) {
    for (const [model, info] of Object.entries(infoByProvider[provider.id] ?? {})) {
      infoByValue[encodeSelection(provider.id, model)] = info;
    }
  }
  const modelsByProvider = new Map<string, string[]>();
  for (const entry of createModelEntries(providers, infoByValue)) {
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

/** Pinning affects the list order only; it must never move a model on the pad. */
export function orderModelEntries(entries: ModelEntry[], pinned: string[]): ModelEntry[] {
  const byValue = new Map(entries.map((entry) => [entry.value, entry]));
  const pinnedEntries = pinned
    .map((value) => byValue.get(value))
    .filter((entry): entry is ModelEntry => Boolean(entry));
  const pinnedSet = new Set(pinnedEntries.map((entry) => entry.value));
  return [...pinnedEntries, ...entries.filter((entry) => !pinnedSet.has(entry.value))];
}

function clamp(value: number, min = 0.08, max = 0.92): number {
  return Math.min(max, Math.max(min, value));
}

function isPercentile(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function labelsFor(x: number, y: number): Pick<PositionedModel, "capabilityLabel" | "paceLabel"> {
  return {
    capabilityLabel: y >= 0.68 ? "Advanced" : y >= 0.4 ? "Capable" : "Everyday",
    paceLabel: x <= 0.34 ? "Faster" : x <= 0.66 ? "Balanced" : "Deliberate",
  };
}

function estimatePosition(
  entry: ModelEntry,
): Omit<PositionedModel, keyof ModelEntry | "capabilityLabel" | "paceLabel"> {
  const ranking = entry.ranking;
  if (
    ranking &&
    isPercentile(ranking.capabilityPercentile) &&
    isPercentile(ranking.responseTimePercentile)
  ) {
    return {
      x: clamp(ranking.responseTimePercentile),
      y: clamp(ranking.capabilityPercentile),
      confidence: "benchmark",
      positionSource: ranking.source,
    };
  }

  let x = 0.5;
  let y = 0.5;
  let signals = 0;
  const model = `${entry.model} ${entry.info?.parameterCount ?? ""}`.toLowerCase();

  if (FAST_VARIANT_RE.test(model)) {
    x -= 0.22;
    y -= 0.14;
    signals += 1;
  }
  if (DEEP_VARIANT_RE.test(model)) {
    x += 0.24;
    y += 0.16;
    signals += 1;
  }
  if (CAPABLE_VARIANT_RE.test(model)) {
    x += 0.1;
    y += 0.12;
    signals += 1;
  }

  const parameterMatch = model.match(PARAMETER_COUNT_RE);
  if (parameterMatch) {
    const billions = Number(parameterMatch[1]);
    if (billions >= 100) {
      x += 0.2;
      y += 0.18;
    } else if (billions >= 60) {
      x += 0.14;
      y += 0.12;
    } else if (billions >= 30) {
      x += 0.08;
      y += 0.07;
    } else if (billions <= 4) {
      x -= 0.18;
      y -= 0.16;
    } else if (billions <= 8) {
      x -= 0.12;
      y -= 0.1;
    }
    signals += 1;
  }

  if (signals === 0) {
    return {
      x,
      y,
      confidence: "unranked",
      positionSource: entry.isLocal
        ? "Benchmark unavailable · local speed depends on this device"
        : "Benchmark unavailable · placed near the balanced midpoint",
    };
  }

  return {
    x: clamp(x),
    y: clamp(y),
    confidence: "estimated",
    positionSource: entry.isLocal
      ? "Estimated from model size or variant · speed depends on this device"
      : "Estimated from the model variant name",
  };
}

export function positionModels(entries: ModelEntry[]): PositionedModel[] {
  const models = entries.map((entry) => ({ ...entry, ...estimatePosition(entry) }));
  const gridSize = modelPadGridSize(models.length);
  const availableCells = modelPadGridPoints(gridSize);
  const confidenceOrder: Record<PositionConfidence, number> = {
    personal: 0,
    suggested: 1,
    benchmark: 2,
    estimated: 3,
    unranked: 4,
  };
  const assignments = new Map<string, ModelPoint>();

  for (const model of [...models].sort(
    (a, b) =>
      confidenceOrder[a.confidence] - confidenceOrder[b.confidence] ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  )) {
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < availableCells.length; index += 1) {
      const cell = availableCells[index];
      const candidateDistance = (cell.x - model.x) ** 2 + (cell.y - model.y) ** 2;
      if (candidateDistance < closestDistance) {
        closestIndex = index;
        closestDistance = candidateDistance;
      }
    }
    const [cell] = availableCells.splice(closestIndex, 1);
    assignments.set(model.value, cell);
  }

  return models.map((model) => {
    const cell = assignments.get(model.value) ?? model;
    return { ...model, ...cell, ...labelsFor(cell.x, cell.y) };
  });
}

/** Saved personal positions are the only models shown on the user-owned Pad. */
export function positionSavedModels(
  entries: ModelEntry[],
  placements: Readonly<Record<string, ModelPadPlacement>>,
): PositionedModel[] {
  const snappedPlacements = reflowVisibleModelPadPlacements(
    placements,
    entries.map((entry) => entry.value),
    modelPadGridSize(entries.length),
  );
  return entries.flatMap((entry) => {
    const placement = snappedPlacements[entry.value];
    if (!placement) return [];
    const x = Math.min(1, Math.max(0, placement.x));
    const y = Math.min(1, Math.max(0, placement.y));
    return [
      {
        ...entry,
        x,
        y,
        confidence:
          placement.xSource === "user" && placement.ySource === "user"
            ? ("personal" as const)
            : ("suggested" as const),
        positionSource:
          placement.xSource === "user" && placement.ySource === "user"
            ? "Personal placement"
            : placement.xSource === "neutral" && placement.ySource === "benchmark"
              ? "Benchmark capability · pace unmeasured"
              : "Benchmark suggestion",
        ...labelsFor(x, y),
      },
    ];
  });
}

function distance(a: ModelPoint, b: ModelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function nearestModel(
  models: PositionedModel[],
  point: ModelPoint,
  currentValue?: string,
  hysteresis = 0.025,
): PositionedModel | undefined {
  if (models.length === 0) return undefined;
  let nearest = models[0];
  let nearestDistance = distance(models[0], point);
  for (const model of models.slice(1)) {
    const candidateDistance = distance(model, point);
    if (candidateDistance < nearestDistance) {
      nearest = model;
      nearestDistance = candidateDistance;
    }
  }

  const current = currentValue ? models.find((model) => model.value === currentValue) : undefined;
  if (current && current.value !== nearest.value) {
    const currentDistance = distance(current, point);
    if (currentDistance - nearestDistance < hysteresis) return current;
  }
  return nearest;
}

export function findDirectionalModel(
  models: PositionedModel[],
  currentValue: string | undefined,
  direction: ModelDirection,
): PositionedModel | undefined {
  if (models.length === 0) return undefined;
  const current = models.find((model) => model.value === currentValue) ?? models[0];

  const candidates = models.filter((model) => {
    if (model.value === current.value) return false;
    if (direction === "left") return model.x < current.x - 0.001;
    if (direction === "right") return model.x > current.x + 0.001;
    if (direction === "up") return model.y > current.y + 0.001;
    return model.y < current.y - 0.001;
  });

  let best: PositionedModel | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dx = Math.abs(candidate.x - current.x);
    const dy = Math.abs(candidate.y - current.y);
    const primary = direction === "left" || direction === "right" ? dx : dy;
    const orthogonal = direction === "left" || direction === "right" ? dy : dx;
    const score = primary + orthogonal * 2.25;
    if (score < bestScore || (score === bestScore && candidate.value < (best?.value ?? ""))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best ?? current;
}

export function modelOptionId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `model-map-option-${(hash >>> 0).toString(36)}`;
}
