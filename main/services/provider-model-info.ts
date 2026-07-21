import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import { modelsCatalog } from "./models-catalog.js";
import { providerRegistry } from "./provider-registry.js";
import type { ModelInfo } from "./types.js";

function unmatched(modelId: string): ModelInfo {
  return {
    id: modelId,
    vision: false,
    toolCall: false,
    reasoning: false,
    openWeights: false,
    matched: false,
  };
}

/** Use Pi's pinned Codex catalog; retain the bundled release catalog elsewhere. */
export const providerModelInfo = {
  async info(providerId: string, modelId: string): Promise<ModelInfo> {
    if (providerId === OPENAI_CODEX_PROVIDER_ID) {
      return providerRegistry.codex.getModelInfo(modelId) ?? unmatched(modelId);
    }
    return modelsCatalog.info(providerId, modelId);
  },

  async infoMany(providerId: string, modelIds: string[]): Promise<Record<string, ModelInfo>> {
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      return modelsCatalog.infoMany(providerId, modelIds);
    }
    const info: Record<string, ModelInfo> = {};
    for (const modelId of modelIds) {
      info[modelId] = providerRegistry.codex.getModelInfo(modelId) ?? unmatched(modelId);
    }
    return info;
  },
};
