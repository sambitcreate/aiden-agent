// Capability metadata comes from the packaged models.dev snapshot plus the
// user's device-local Artificial Analysis cache. Reading model info never
// performs a network request; only explicit connect/refresh actions update it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, logger } from "../platform.js";
import {
  EMPTY_ARTIFICIAL_ANALYSIS_CATALOG,
  type ArtificialAnalysisCatalog,
} from "./artificial-analysis-catalog-core.js";
import { artificialAnalysisRuntime } from "./artificial-analysis-runtime.js";
import {
  createModelCatalogLoader,
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

async function loadArtificialAnalysis(): Promise<ArtificialAnalysisCatalog> {
  try {
    const local = await artificialAnalysisRuntime.catalog();
    if (local) return local;
  } catch (error) {
    logger.warn("models-catalog", "Could not read the device-local Artificial Analysis cache.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return EMPTY_ARTIFICIAL_ANALYSIS_CATALOG;
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

  /** Capability info for one model. */
  async info(provider: ModelCatalogProvider, modelId: string): Promise<ModelInfo> {
    const [modelsDev, artificialAnalysis] = await Promise.all([
      getModelsDev(),
      loadArtificialAnalysis(),
    ]);
    return resolveModelInfo(modelsDev, artificialAnalysis, provider, modelId);
  },

  /** Capability info for many models under one provider. */
  async infoMany(
    provider: ModelCatalogProvider,
    modelIds: string[],
  ): Promise<Record<string, ModelInfo>> {
    const [modelsDev, artificialAnalysis] = await Promise.all([
      getModelsDev(),
      loadArtificialAnalysis(),
    ]);
    return Object.fromEntries(
      modelIds.map((id) => [id, resolveModelInfo(modelsDev, artificialAnalysis, provider, id)]),
    );
  },
};
