// Main-process dependency wiring for the Electron-free runtime resolver.

import { configStore } from "./config-store.js";
import { resolveModelRuntimeWith, type ResolvedModelRuntime } from "./model-runtime-core.js";
import { catalogProviderSlug } from "./models-catalog-core.js";
import { modelsCatalog } from "./models-catalog.js";
import { providerRegistry } from "./provider-registry.js";
import { secrets } from "./secrets.js";

export type { ResolvedModelRuntime };

export function resolveModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ResolvedModelRuntime> {
  return resolveModelRuntimeWith(
    {
      getProvider: (id) => configStore.getProvider(id),
      getApiKey: (id) => secrets.getKey(id),
      resolveRuntimeLimits: (provider, id) => {
        const piProviderId = catalogProviderSlug(provider.id);
        const exact = piProviderId ? providerRegistry.models.getModel(piProviderId, id) : undefined;
        return modelsCatalog.runtimeLimits(provider, id, exact);
      },
      codex: providerRegistry.codex,
    },
    providerId,
    modelId,
    signal,
  );
}
