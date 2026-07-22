import * as path from "node:path";
import { app, logger } from "../platform.js";
import { FileArtificialAnalysisCacheStore } from "./artificial-analysis-cache.js";
import {
  ArtificialAnalysisRuntime,
  fetchArtificialAnalysisUserCache,
} from "./artificial-analysis-runtime-core.js";
import { piCredentialStore } from "./pi-credential-store.js";

const CREDENTIAL_ID = "artificial-analysis";
const CACHE_FILE = "artificial-analysis-model-cache.json";
const GENERATION_ENV = "AIDEN_ARTIFICIAL_ANALYSIS_GENERATION";

const credentials = {
  async read() {
    const credential = await piCredentialStore.read(CREDENTIAL_ID);
    if (!credential) return null;
    if (credential.type !== "api_key" || typeof credential.key !== "string" || !credential.key) {
      throw new Error("Stored Artificial Analysis credentials are invalid.");
    }
    const generation = credential.env?.[GENERATION_ENV];
    return {
      key: credential.key,
      generation:
        typeof generation === "string" && generation ? generation : "legacy-unbound-generation",
    };
  },

  async write(credential: { key: string; generation: string }): Promise<void> {
    await piCredentialStore.modify(CREDENTIAL_ID, async () => ({
      type: "api_key",
      key: credential.key,
      env: { [GENERATION_ENV]: credential.generation },
    }));
  },

  async deleteKey(): Promise<void> {
    await piCredentialStore.delete(CREDENTIAL_ID);
  },
};

const cache = new FileArtificialAnalysisCacheStore({
  filePath: () => path.join(app.getPath("userData"), CACHE_FILE),
  onInvalid: (error) => {
    logger.warn("artificial-analysis", "Ignoring an invalid device-local model cache.", {
      error: error.message,
    });
  },
  onDurabilityWarning: (error) => {
    logger.warn("artificial-analysis", "The model cache was saved without a directory sync.", {
      error: error.message,
    });
  },
});

/** Runtime access is manual-only: only connect() and refresh() perform network requests. */
export const artificialAnalysisRuntime = new ArtificialAnalysisRuntime({
  credentials,
  cache,
  fetchCatalog: (key) => fetchArtificialAnalysisUserCache(key),
});
