// Electron-free assembly of the model-info reader. Capability metadata comes
// from the packaged models.dev snapshot, optionally overlaid by the validated
// device-local display cache. Nothing here performs a network request.

import {
  createModelCatalogLoader,
  lookupCatalogModelInfo,
  resolveModelInfo,
  resolveProviderRuntimeLimits,
  type ModelCatalog,
  type ModelCatalogProvider,
  type RuntimeCatalogProvider,
  type RuntimeModelMetadata,
} from "./models-catalog-core.js";
import type { ModelInfo } from "./types.js";

export interface ModelsCatalogReaderDependencies {
  /** Raw bundled snapshot; parsed once and memoized. */
  loadBundled: () => Promise<unknown>;
  /** Device-local display cache: returns its catalog, or `fallback` when absent. */
  displayCache: { catalog(fallback: ModelCatalog): Promise<ModelCatalog> };
  warn: (message: string, error: unknown) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createModelsCatalogReader(deps: ModelsCatalogReaderDependencies) {
  const getModelsDev = createModelCatalogLoader(deps.loadBundled, (error) => {
    deps.warn("Could not read bundled model capability catalog.", { error: errorMessage(error) });
  });

  async function getDisplayModelsDev() {
    const bundled = await getModelsDev();
    try {
      return await deps.displayCache.catalog(bundled);
    } catch (error) {
      deps.warn("Could not read the device-local models.dev cache.", {
        error: errorMessage(error),
      });
      return bundled;
    }
  }

  return {
    /** Request-time model limits from Pi-exact metadata and the bundled offline snapshot only. */
    async runtimeLimits(
      provider: RuntimeCatalogProvider,
      modelId: string,
      exact?: RuntimeModelMetadata,
    ) {
      return resolveProviderRuntimeLimits(await getModelsDev(), provider, modelId, exact);
    },

    /** Bundled-only capability lookup for request admission; never reads user credentials/caches. */
    async bundledInfo(provider: ModelCatalogProvider, modelId: string): Promise<ModelInfo> {
      return lookupCatalogModelInfo(await getModelsDev(), provider.id, modelId);
    },

    /** Capability info for one model. */
    async info(provider: ModelCatalogProvider, modelId: string): Promise<ModelInfo> {
      return resolveModelInfo(await getDisplayModelsDev(), provider, modelId);
    },

    /** Capability info for many models under one provider. */
    async infoMany(
      provider: ModelCatalogProvider,
      modelIds: string[],
    ): Promise<Record<string, ModelInfo>> {
      const modelsDev = await getDisplayModelsDev();
      return Object.fromEntries(
        modelIds.map((id) => [id, resolveModelInfo(modelsDev, provider, id)]),
      );
    },
  };
}
