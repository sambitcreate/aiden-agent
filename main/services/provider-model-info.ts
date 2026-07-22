import { configStore } from "./config-store.js";
import { modelsCatalog } from "./models-catalog.js";
import { createProviderModelInfo } from "./provider-model-info-core.js";
import { providerRegistry } from "./provider-registry.js";

async function legacyProvider(providerId: string) {
  return (await configStore.getProvider(providerId)) ?? { id: providerId, baseUrl: "" };
}

/** Keep Pi's pinned Codex capabilities and enrich them from the local AA cache. */
export const providerModelInfo = createProviderModelInfo({
  modelsCatalog,
  legacyProvider,
  codexModelInfo: (modelId) => providerRegistry.codex.getModelInfo(modelId),
});
