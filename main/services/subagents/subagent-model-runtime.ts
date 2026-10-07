// Binds the pure model-selection policy to host-resolved Pi runtimes. Each
// child's runtime is resolved on the Mac host from the chosen provider and
// model; nothing here touches permissions, approvals, or workspace roots.

import type { Api, Model } from "@earendil-works/pi-ai";
import { GENERATION_THINKING_LEVELS, type GenerationThinkingLevel } from "../../../renderer/shared/generation-thinking.js";
import { isLocalProviderDeployment, type ProviderDeploymentFields } from "../../../renderer/shared/provider-deployment.js";
import { normalizeProviderThinkingLevel } from "../../../renderer/shared/provider-thinking.js";
import { ANTHROPIC_PROVIDER_ID } from "../anthropic-provider.js";
import { OPENAI_CODEX_PROVIDER_ID } from "../codex-provider.js";
import { resolveGenerationThinkingLevel } from "../generation-runtime.js";
import { GOOGLE_PROVIDER_ID } from "../google-provider.js";
import { isNonChatModel } from "../../../renderer/shared/model-eligibility.js";
import type { AppSettings, Provider } from "../types.js";
import {
  finalizeSubagentModel,
  planSubagentModel,
  isSubagentModelKey,
  subagentModelKey,
  type SubagentModelCandidate,
  type SubagentModelPolicy,
  type SubagentModelRequest,
  type SubagentModelRuntimeFacts,
  type SubagentModelSelection,
} from "./subagent-model-selection.js";

export interface SubagentModelRuntimeLike {
  provider: ProviderDeploymentFields & { id: string };
  model: Pick<Model<Api>, "id" | "reasoning" | "thinkingLevelMap" | "cost">;
}

type ThinkingSettings = Pick<
  AppSettings,
  "googleThinkingByModel" | "codexThinkingByModel" | "anthropicThinkingByModel" | "providerThinkingByModel"
>;

export function savedThinkingLevelFor(
  settings: ThinkingSettings,
  providerId: string,
  modelId: string,
): GenerationThinkingLevel | undefined {
  if (providerId === GOOGLE_PROVIDER_ID) return settings.googleThinkingByModel?.[modelId];
  if (providerId === OPENAI_CODEX_PROVIDER_ID) return settings.codexThinkingByModel?.[modelId];
  if (providerId === ANTHROPIC_PROVIDER_ID) return settings.anthropicThinkingByModel?.[modelId];
  return settings.providerThinkingByModel?.[providerId]?.[modelId];
}

/** Efforts are exactly the levels Pi would send unchanged for this model. */
export function subagentModelRuntimeFacts(
  runtime: SubagentModelRuntimeLike,
  savedEffort: GenerationThinkingLevel | undefined,
): SubagentModelRuntimeFacts {
  const providerId = runtime.provider.id;
  const supportedEfforts = GENERATION_THINKING_LEVELS.filter(
    (level) => resolveGenerationThinkingLevel(providerId, runtime.model, level) === level,
  );
  const defaultEffort = resolveGenerationThinkingLevel(
    providerId,
    runtime.model,
    savedEffort ?? normalizeProviderThinkingLevel(supportedEfforts, undefined),
  );
  return {
    supportedEfforts,
    defaultEffort,
    local: isLocalProviderDeployment(runtime.provider),
    ...(runtime.model.cost
      ? { cost: { input: runtime.model.cost.input, output: runtime.model.cost.output } }
      : {}),
  };
}

const MAX_SUBAGENT_MODEL_CANDIDATES = 128;

/** Connected chat models in discovery order, each provider's default first. */
export function subagentModelCandidatesFromProviders(
  providers: readonly Pick<Provider, "id" | "label" | "needsKey" | "hasKey" | "models" | "defaultModel" | "modelMetadata">[],
): SubagentModelCandidate[] {
  const candidates: SubagentModelCandidate[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (provider.needsKey && !provider.hasKey) continue;
    const models = [...provider.models].sort(
      (left, right) => Number(right === provider.defaultModel) - Number(left === provider.defaultModel),
    );
    for (const modelId of models) {
      const candidate = {
        providerId: provider.id,
        providerLabel: provider.label.trim() || provider.id,
        modelId,
        modelLabel: provider.modelMetadata?.[modelId]?.name?.trim() || modelId,
      };
      const key = subagentModelKey(candidate);
      if (seen.has(key) || !isSubagentModelKey(key)) continue;
      if (isNonChatModel({ model: modelId, metadataType: provider.modelMetadata?.[modelId]?.type })) continue;
      seen.add(key);
      candidates.push(candidate);
      if (candidates.length >= MAX_SUBAGENT_MODEL_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

export interface SubagentChildModel<Runtime> {
  selection: SubagentModelSelection;
  runtime: Runtime;
}

export interface SubagentModelResolverInput<Runtime extends SubagentModelRuntimeLike> {
  policy: SubagentModelPolicy;
  parentRuntime: Runtime;
  savedEffort: (providerId: string, modelId: string) => GenerationThinkingLevel | undefined;
  resolveRuntime: (providerId: string, modelId: string, signal: AbortSignal) => Promise<Runtime>;
}

export type SubagentChildModelResolver<Runtime> = (
  request: SubagentModelRequest,
  signal: AbortSignal,
  /** The depth-1 child whose model a depth-2 child inherits by default. */
  inheritFrom?: SubagentChildModel<Runtime>,
) => Promise<SubagentChildModel<Runtime>>;

/**
 * Resolve each child's model once per distinct choice. The parent runtime is
 * reused by identity so inherited children keep the exact parent binding.
 * Selection failures throw with the allowed values; there is no silent fallback.
 */
export function createSubagentChildModelResolver<Runtime extends SubagentModelRuntimeLike>(
  input: SubagentModelResolverInput<Runtime>,
): SubagentChildModelResolver<Runtime> {
  const parentKey = subagentModelKey(input.policy.parent);
  const runtimes = new Map<string, Promise<Runtime>>([[parentKey, Promise.resolve(input.parentRuntime)]]);
  const resolvedParentFacts = subagentModelRuntimeFacts(
    input.parentRuntime,
    input.savedEffort(input.policy.parent.providerId, input.policy.parent.modelId),
  );
  // The parent's level was already resolved for this exact runtime, including
  // custom providers that keep "off" when no level was requested.
  const parentFacts: SubagentModelRuntimeFacts = resolvedParentFacts.supportedEfforts.includes(input.policy.parent.effort)
    ? resolvedParentFacts
    : {
        ...resolvedParentFacts,
        supportedEfforts: [input.policy.parent.effort, ...resolvedParentFacts.supportedEfforts],
      };
  return async (request, signal, inheritFrom) => {
    const inherited = inheritFrom
      ? {
          providerId: inheritFrom.selection.providerId,
          providerLabel: inheritFrom.selection.providerLabel,
          modelId: inheritFrom.selection.modelId,
          modelLabel: inheritFrom.selection.modelLabel,
          effort: inheritFrom.selection.effort,
        }
      : undefined;
    const planned = planSubagentModel(input.policy, request, inherited);
    if (!planned.ok) throw new Error(planned.error);
    const key = subagentModelKey(planned.value.candidate);
    if (inheritFrom && inherited && key === subagentModelKey(inherited)) {
      const facts = subagentModelRuntimeFacts(
        inheritFrom.runtime,
        input.savedEffort(inherited.providerId, inherited.modelId),
      );
      const finalized = finalizeSubagentModel(
        input.policy,
        planned.value,
        facts.supportedEfforts.includes(inherited.effort)
          ? facts
          : { ...facts, supportedEfforts: [inherited.effort, ...facts.supportedEfforts] },
        parentFacts,
      );
      if (!finalized.ok) throw new Error(finalized.error);
      return { selection: finalized.value, runtime: inheritFrom.runtime };
    }
    let pending = runtimes.get(key);
    if (!pending) {
      pending = input.resolveRuntime(planned.value.candidate.providerId, planned.value.candidate.modelId, signal);
      runtimes.set(key, pending);
      pending.catch(() => runtimes.delete(key));
    }
    const runtime = await pending;
    signal.throwIfAborted();
    const facts =
      key === parentKey
        ? parentFacts
        : subagentModelRuntimeFacts(runtime, input.savedEffort(runtime.provider.id, runtime.model.id));
    const finalized = finalizeSubagentModel(input.policy, planned.value, facts, parentFacts);
    if (!finalized.ok) throw new Error(finalized.error);
    return { selection: finalized.value, runtime };
  };
}
