import { OPENAI_CODEX_BASE_URL, OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import type { ModelCatalogProvider } from "./models-catalog-core.js";
import type { ModelInfo } from "./types.js";

interface ModelCatalogReader {
  info(provider: ModelCatalogProvider, modelId: string): Promise<ModelInfo>;
  infoMany(provider: ModelCatalogProvider, modelIds: string[]): Promise<Record<string, ModelInfo>>;
}

interface ProviderModelInfoDependencies {
  modelsCatalog: ModelCatalogReader;
  legacyProvider(providerId: string): Promise<ModelCatalogProvider>;
  codexModelInfo(modelId: string): ModelInfo | undefined;
}

const CODEX_CATALOG_PROVIDER: ModelCatalogProvider = {
  id: OPENAI_CODEX_PROVIDER_ID,
  baseUrl: OPENAI_CODEX_BASE_URL,
};

function unmatched(modelId: string): ModelInfo {
  return {
    id: modelId,
    vision: false,
    toolCall: false,
    reasoning: false,
    openWeights: false,
    metadataSource: "fallback",
    matched: false,
  };
}

export function mergeCodexModelInfo(
  modelId: string,
  pinned: ModelInfo | undefined,
  catalog: ModelInfo,
): ModelInfo {
  if (!pinned) return unmatched(modelId);
  if (!catalog.ranking) return pinned;
  return {
    ...pinned,
    ranking: catalog.ranking,
    metadataSource: "artificial-analysis",
    matched: true,
  };
}

/** Preserve Pi's pinned Codex capabilities while enriching them with local benchmark data. */
export function createProviderModelInfo(dependencies: ProviderModelInfoDependencies) {
  return {
    async info(providerId: string, modelId: string): Promise<ModelInfo> {
      if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
        return dependencies.modelsCatalog.info(
          await dependencies.legacyProvider(providerId),
          modelId,
        );
      }
      const catalog = await dependencies.modelsCatalog.info(CODEX_CATALOG_PROVIDER, modelId);
      return mergeCodexModelInfo(modelId, dependencies.codexModelInfo(modelId), catalog);
    },

    async infoMany(providerId: string, modelIds: string[]): Promise<Record<string, ModelInfo>> {
      if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
        return dependencies.modelsCatalog.infoMany(
          await dependencies.legacyProvider(providerId),
          modelIds,
        );
      }
      const catalog = await dependencies.modelsCatalog.infoMany(CODEX_CATALOG_PROVIDER, modelIds);
      return Object.fromEntries(
        modelIds.map((modelId) => [
          modelId,
          mergeCodexModelInfo(
            modelId,
            dependencies.codexModelInfo(modelId),
            catalog[modelId] ?? unmatched(modelId),
          ),
        ]),
      );
    },
  };
}
