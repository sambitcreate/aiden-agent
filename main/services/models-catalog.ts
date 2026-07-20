// Model capability metadata is a static release asset. The app never refreshes
// it or contacts an external catalog: release tooling writes the snapshot before
// a distributable is built, and the packaged app reads it from app.asar.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, logger } from "../platform.js";
import {
  lookupCatalogModelInfo,
  parseModelCatalog,
  type ModelCatalog,
} from "./models-catalog-core.js";
import type { ModelInfo } from "./types.js";

const BUNDLED_CATALOG_PARTS = ["resources", "model-capabilities.json"] as const;

let catalog: Promise<ModelCatalog> | null = null;

function bundledCatalogPath(): string {
  return join(app.getAppPath(), ...BUNDLED_CATALOG_PARTS);
}

async function loadBundledCatalog(): Promise<ModelCatalog> {
  const path = bundledCatalogPath();
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

function getCatalog(): Promise<ModelCatalog> {
  catalog ??= loadBundledCatalog();
  return catalog;
}

export const modelsCatalog = {
  /** Capability info for one model. */
  async info(providerId: string, modelId: string): Promise<ModelInfo> {
    return lookupCatalogModelInfo(await getCatalog(), providerId, modelId);
  },

  /** Capability info for many models under one provider. */
  async infoMany(providerId: string, modelIds: string[]): Promise<Record<string, ModelInfo>> {
    const snapshot = await getCatalog();
    const out: Record<string, ModelInfo> = {};
    for (const id of modelIds) out[id] = lookupCatalogModelInfo(snapshot, providerId, id);
    return out;
  },
};
