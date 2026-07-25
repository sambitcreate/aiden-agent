// Main-process dependency wiring for the Electron-free runtime resolver.

import type { AnthropicMessagesCompat } from "@earendil-works/pi-ai";
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
        const piModel = piProviderId ? providerRegistry.models.getModel(piProviderId, id) : undefined;
        const forceAdaptiveThinking =
          piModel?.api === "anthropic-messages"
            ? (piModel.compat as AnthropicMessagesCompat | undefined)
                ?.forceAdaptiveThinking
            : undefined;
        const exact = piModel
          ? { ...piModel, forceAdaptiveThinking }
          : undefined;
        return modelsCatalog.runtimeLimits(provider, id, exact);
      },
      codex: providerRegistry.codex,
      google: providerRegistry.google,
    },
    providerId,
    modelId,
    signal,
  );
}
