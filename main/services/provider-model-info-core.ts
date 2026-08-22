import { OPENAI_CODEX_BASE_URL, OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import type { ModelCatalogProvider } from "./models-catalog-core.js";
import type { ModelInfo, ProviderModelMetadata, StoredProvider } from "./types.js";

interface ModelCatalogReader {
  info(provider: ModelCatalogProvider, modelId: string): Promise<ModelInfo>;
  infoMany(provider: ModelCatalogProvider, modelIds: string[]): Promise<Record<string, ModelInfo>>;
}

interface ProviderModelInfoDependencies {
  modelsCatalog: ModelCatalogReader;
  legacyProvider(
    providerId: string,
  ): Promise<ModelCatalogProvider & Pick<StoredProvider, "modelMetadata">>;
  codexModelInfo(modelId: string): ModelInfo | undefined;
}

function providerInfo(modelId: string, metadata: ProviderModelMetadata | undefined): ModelInfo | undefined {
  if (!metadata) return undefined;
  return {
    id: modelId,
    name: metadata.name,
    vision: metadata.vision ?? false,
    toolCall: metadata.toolCall ?? false,
    reasoning: metadata.reasoning ?? false,
    openWeights: false,
    modelType: metadata.type,
    parameterCount: metadata.parameterCount,
    format: metadata.format,
    contextLength: metadata.contextLength,
    inputModalities: metadata.vision ? ["text", "image"] : ["text"],
    metadataSource: "provider",
    matched: true,
  };
}

function withProviderFallback(
  modelId: string,
  catalog: ModelInfo,
  metadata: ProviderModelMetadata | undefined,
): ModelInfo {
  return catalog.matched ? catalog : (providerInfo(modelId, metadata) ?? catalog);
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
        const provider = await dependencies.legacyProvider(providerId);
        const catalog = await dependencies.modelsCatalog.info(provider, modelId);
        return withProviderFallback(modelId, catalog, provider.modelMetadata?.[modelId]);
      }
      const catalog = await dependencies.modelsCatalog.info(CODEX_CATALOG_PROVIDER, modelId);
      return mergeCodexModelInfo(modelId, dependencies.codexModelInfo(modelId), catalog);
    },

    async infoMany(providerId: string, modelIds: string[]): Promise<Record<string, ModelInfo>> {
      if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
        const provider = await dependencies.legacyProvider(providerId);
        const catalog = await dependencies.modelsCatalog.infoMany(provider, modelIds);
        return Object.fromEntries(
          modelIds.map((modelId) => [
            modelId,
            withProviderFallback(
              modelId,
              catalog[modelId] ?? unmatched(modelId),
              provider.modelMetadata?.[modelId],
            ),
          ]),
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
