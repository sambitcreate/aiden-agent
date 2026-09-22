// Capability metadata comes from the packaged models.dev snapshot. Optional
// benchmark evidence comes from the dedicated device-local OpenRouter cache.
// Reading model info never performs a network request.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, logger } from "../platform.js";
import { EMPTY_ARTIFICIAL_ANALYSIS_CATALOG } from "./artificial-analysis-catalog-core.js";
import { openRouterBenchmarkRuntime } from "./openrouter-benchmark-runtime.js";
import { modelsDevCacheRuntime } from "./models-dev-cache.js";
import {
  createModelCatalogLoader,
  lookupCatalogModelInfo,
  resolveModelInfo,
  resolveProviderRuntimeLimits,
  type ModelCatalogProvider,
  type RuntimeCatalogProvider,
  type RuntimeModelMetadata,
} from "./models-catalog-core.js";
import type { ModelInfo } from "./types.js";

const BUNDLED_MODELS_DEV_PARTS = ["resources", "model-capabilities.json"] as const;

function bundledPath(parts: readonly string[]): string {
  return join(app.getAppPath(), ...parts);
}

const getModelsDev = createModelCatalogLoader(
  async () => {
    const path = bundledPath(BUNDLED_MODELS_DEV_PARTS);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  },
  (error) => {
    logger.warn("models-catalog", "Could not read bundled model capability catalog.", {
      error: error instanceof Error ? error.message : String(error),
    });
  },
);

async function getDisplayModelsDev() {
  const bundled = await getModelsDev();
  try {
    return await modelsDevCacheRuntime.catalog(bundled);
  } catch (error) {
    logger.warn("models-catalog", "Could not read the device-local models.dev cache.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return bundled;
  }
}

async function loadOpenRouterBenchmarks() {
  try {
    return await openRouterBenchmarkRuntime.catalog();
  } catch (error) {
    logger.warn("models-catalog", "Could not read the device-local OpenRouter benchmark cache.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const modelsCatalog = {
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
    const [modelsDev, openRouterBenchmarks] = await Promise.all([
      getDisplayModelsDev(),
      loadOpenRouterBenchmarks(),
    ]);
    return resolveModelInfo(
      modelsDev,
      EMPTY_ARTIFICIAL_ANALYSIS_CATALOG,
      provider,
      modelId,
      openRouterBenchmarks,
    );
  },

  /** Capability info for many models under one provider. */
  async infoMany(
    provider: ModelCatalogProvider,
    modelIds: string[],
  ): Promise<Record<string, ModelInfo>> {
    const [modelsDev, openRouterBenchmarks] = await Promise.all([
      getDisplayModelsDev(),
      loadOpenRouterBenchmarks(),
    ]);
    return Object.fromEntries(
      modelIds.map((id) => [
        id,
        resolveModelInfo(
          modelsDev,
          EMPTY_ARTIFICIAL_ANALYSIS_CATALOG,
          provider,
          id,
          openRouterBenchmarks,
        ),
      ]),
    );
  },
};
