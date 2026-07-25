import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  anthropicThinkingCanDisable,
  anthropicThinkingLevelsForModel,
  isAnthropicThinkingLevel,
  type AnthropicThinkingLevel,
} from "../../renderer/shared/anthropic-thinking.js";
import type { Provider, ProviderModelMetadata } from "./types.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_DEFAULT_MODELS = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5",
] as const;
export const ANTHROPIC_DEFAULT_MODEL = ANTHROPIC_DEFAULT_MODELS[0];
const LEGACY_DEFAULT_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest",
] as const;

const builtinAnthropicModels = getBuiltinModels(ANTHROPIC_PROVIDER_ID);
const modelsById = new Map(
  builtinAnthropicModels.map((model) => [model.id, model]),
);

function thinkingMetadata(model: Model<Api>): Partial<ProviderModelMetadata> {
  return {
    reasoning: model.reasoning,
    thinkingLevels: anthropicThinkingLevelsForModel(model),
    thinkingCanDisable: anthropicThinkingCanDisable(model),
  };
}

/** Add pinned Pi thinking capabilities without replacing discovered display metadata. */
export function enrichAnthropicProviders(
  providers: Provider[],
): Provider[] {
  return providers.map((provider) => {
    if (provider.id !== ANTHROPIC_PROVIDER_ID) return provider;
    const modelMetadata = { ...provider.modelMetadata };
    for (const modelId of provider.models) {
      const model = modelsById.get(modelId);
      if (!model) continue;
      modelMetadata[modelId] = {
        ...modelMetadata[modelId],
        source: modelMetadata[modelId]?.source ?? "provider",
        ...thinkingMetadata(model),
      };
    }
    return { ...provider, modelMetadata };
  });
}

export function parseAnthropicThinkingSelection(
  modelIdValue: unknown,
  levelValue: unknown,
): { modelId: string; level: AnthropicThinkingLevel } {
  if (typeof modelIdValue !== "string") {
    throw new Error("Invalid Anthropic model.");
  }
  const model = modelsById.get(modelIdValue);
  if (!model?.reasoning) {
    throw new Error("This Anthropic model does not support thinking.");
  }
  if (
    !isAnthropicThinkingLevel(levelValue) ||
    !anthropicThinkingLevelsForModel(model).includes(levelValue)
  ) {
    throw new Error(
      "This thinking level is not supported by the selected Anthropic model.",
    );
  }
  return { modelId: modelIdValue, level: levelValue };
}

interface AnthropicProviderConfig {
  providers: Array<Omit<Provider, "hasKey">>;
  settings: { lastProviderId?: string; lastModel?: string };
}

/** Refresh only Aiden's untouched legacy preset; preserve user-discovered model lists. */
export function migrateLegacyAnthropicPreset(
  config: AnthropicProviderConfig,
): boolean {
  const provider = config.providers.find(
    (candidate) => candidate.id === ANTHROPIC_PROVIDER_ID,
  );
  if (
    !provider?.isPreset ||
    provider.models.length !== LEGACY_DEFAULT_MODELS.length ||
    !LEGACY_DEFAULT_MODELS.every(
      (modelId, index) => provider.models[index] === modelId,
    )
  ) {
    return false;
  }
  provider.models = [...ANTHROPIC_DEFAULT_MODELS];
  provider.defaultModel = ANTHROPIC_DEFAULT_MODEL;
  provider.modelMetadata = undefined;
  if (config.settings.lastProviderId === ANTHROPIC_PROVIDER_ID) {
    config.settings.lastModel = ANTHROPIC_DEFAULT_MODEL;
  }
  return true;
}
