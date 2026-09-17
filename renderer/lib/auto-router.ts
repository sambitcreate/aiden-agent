import {
  classifyTask,
  computeBenchmarkScore,
  computeCostScore,
  computeSpeedScore,
  filterEligibleCandidates,
  getRoutingWeights,
  promptRequiresVision,
  resolveAutoRoute,
  type AutoRouteResolution,
  type AutoRouterCandidate,
  type ComplexityTier,
  type TaskClassification,
} from "../../main/services/auto-router-core.js";
import type { Provider } from "./types.js";
import type { ModelEntry } from "./model-picker-data.js";
import type { ModelPadPlacement } from "./model-pad-layout.js";
import { isUsable } from "./model-picker-data.js";

export const AUTO_ROUTER_PROVIDER_ID = "auto";
export const AUTO_ROUTER_MODEL_ID = "auto";
export const AUTO_ROUTER_SELECTION_VALUE = "auto::auto";

export function isAutoRouterSelection(providerId: string, model: string): boolean {
  return (
    (providerId === AUTO_ROUTER_PROVIDER_ID && model === AUTO_ROUTER_MODEL_ID) ||
    providerId === "auto-router"
  );
}

/**
 * Builds candidate model records from visible model entries and their optional
 * Model Pad spatial placements.
 */
export function buildAutoRouterCandidates(
  entries: readonly ModelEntry[],
  placements: Readonly<Record<string, ModelPadPlacement>> | undefined,
  providers: readonly Provider[],
): AutoRouterCandidate[] {
  const providersById = new Map(providers.map((p) => [p.id, p]));
  const candidates: AutoRouterCandidate[] = [];

  for (const entry of entries) {
    const provider = providersById.get(entry.providerId);
    const placement = placements?.[entry.value];

    candidates.push({
      providerId: entry.providerId,
      model: entry.model,
      label: entry.label,
      providerLabel: entry.providerLabel,
      isLocal: entry.isLocal,
      isUsable: provider ? isUsable(provider) : false,
      info: entry.info,
      placement: placement
        ? { x: placement.x, y: placement.y }
        : undefined,
    });
  }

  return candidates;
}

export {
  classifyTask,
  computeBenchmarkScore,
  computeCostScore,
  computeSpeedScore,
  filterEligibleCandidates,
  getRoutingWeights,
  promptRequiresVision,
  resolveAutoRoute,
  type AutoRouteResolution,
  type AutoRouterCandidate,
  type ComplexityTier,
  type TaskClassification,
};
