// Model metadata is read exclusively from release assets plus provider metadata
// captured during explicit local discovery. The running app never contacts a
// public catalog.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, logger } from "../platform.js";
import {
  EMPTY_ARTIFICIAL_ANALYSIS_SNAPSHOT,
  parseArtificialAnalysisSnapshot,
  type ArtificialAnalysisSnapshot,
} from "./artificial-analysis-catalog-core.js";
import {
  parseModelCatalog,
  resolveModelInfo,
  type ModelCatalog,
  type ModelCatalogProvider,
} from "./models-catalog-core.js";
import type { ModelInfo } from "./types.js";

const BUNDLED_MODELS_DEV_PARTS = ["resources", "model-capabilities.json"] as const;
const BUNDLED_ARTIFICIAL_ANALYSIS_PARTS = ["resources", "artificial-analysis-models.json"] as const;

interface CatalogSnapshots {
  modelsDev: ModelCatalog;
  artificialAnalysis: ArtificialAnalysisSnapshot;
}

let snapshots: Promise<CatalogSnapshots> | null = null;

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

async function loadArtificialAnalysis(): Promise<ArtificialAnalysisSnapshot> {
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

function getSnapshots(): Promise<CatalogSnapshots> {
  snapshots ??= Promise.all([loadModelsDev(), loadArtificialAnalysis()]).then(
    ([modelsDev, artificialAnalysis]) => ({ modelsDev, artificialAnalysis }),
  );
  return snapshots;
}

export const modelsCatalog = {
  /** Capability info for one model. */
  async info(provider: ModelCatalogProvider, modelId: string): Promise<ModelInfo> {
    const loaded = await getSnapshots();
    return resolveModelInfo(loaded.modelsDev, loaded.artificialAnalysis, provider, modelId);
  },

  /** Capability info for many models under one provider. */
  async infoMany(
    provider: ModelCatalogProvider,
    modelIds: string[],
  ): Promise<Record<string, ModelInfo>> {
    const loaded = await getSnapshots();
    return Object.fromEntries(
      modelIds.map((id) => [
        id,
        resolveModelInfo(loaded.modelsDev, loaded.artificialAnalysis, provider, id),
      ]),
    );
  },
};
