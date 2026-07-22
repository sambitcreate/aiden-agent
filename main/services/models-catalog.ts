// Capability metadata comes from the packaged models.dev snapshot plus the
// user's device-local Artificial Analysis cache. Reading model info never
// performs a network request; only explicit connect/refresh actions update it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, logger } from "../platform.js";
import {
  EMPTY_ARTIFICIAL_ANALYSIS_SNAPSHOT,
  parseArtificialAnalysisSnapshot,
  type ArtificialAnalysisCatalog,
  type ArtificialAnalysisSnapshot,
} from "./artificial-analysis-catalog-core.js";
import { artificialAnalysisRuntime } from "./artificial-analysis-runtime.js";
import {
  parseModelCatalog,
  resolveModelInfo,
  type ModelCatalog,
  type ModelCatalogProvider,
} from "./models-catalog-core.js";
import type { ModelInfo } from "./types.js";

const BUNDLED_MODELS_DEV_PARTS = ["resources", "model-capabilities.json"] as const;
const BUNDLED_ARTIFICIAL_ANALYSIS_PARTS = ["resources", "artificial-analysis-models.json"] as const;

let modelsDevSnapshot: Promise<ModelCatalog> | null = null;
let bundledArtificialAnalysisSnapshot: Promise<ArtificialAnalysisSnapshot> | null = null;

function bundledPath(parts: readonly string[]): string {
  return join(app.getAppPath(), ...parts);
}

async function loadModelsDev(): Promise<ModelCatalog> {
  const path = bundledPath(BUNDLED_MODELS_DEV_PARTS);
  try {
    return parseModelCatalog(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    logger.warn("models-catalog", "Could not read bundled model capability catalog.", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

async function loadBundledArtificialAnalysis(): Promise<ArtificialAnalysisSnapshot> {
  const path = bundledPath(BUNDLED_ARTIFICIAL_ANALYSIS_PARTS);
  try {
    return parseArtificialAnalysisSnapshot(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    logger.warn("models-catalog", "Could not read bundled Artificial Analysis snapshot.", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_ARTIFICIAL_ANALYSIS_SNAPSHOT;
  }
}

function getBundledArtificialAnalysis(): Promise<ArtificialAnalysisSnapshot> {
  bundledArtificialAnalysisSnapshot ??= loadBundledArtificialAnalysis();
  return bundledArtificialAnalysisSnapshot;
}

async function loadArtificialAnalysis(): Promise<ArtificialAnalysisCatalog> {
  try {
    const local = await artificialAnalysisRuntime.catalog();
    if (local) return local;
  } catch (error) {
    logger.warn("models-catalog", "Could not read the device-local Artificial Analysis cache.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return getBundledArtificialAnalysis();
}

function getModelsDev(): Promise<ModelCatalog> {
  modelsDevSnapshot ??= loadModelsDev();
  return modelsDevSnapshot;
}

export const modelsCatalog = {
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
