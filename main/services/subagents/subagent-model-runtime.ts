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
import type { Settings } from "../types.js";
import {
  finalizeSubagentModel,
  planSubagentModel,
  subagentModelKey,
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
  Settings,
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
  return async (request, signal) => {
    const planned = planSubagentModel(input.policy, request);
    if (!planned.ok) throw new Error(planned.error);
    const key = subagentModelKey(planned.value.candidate);
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
