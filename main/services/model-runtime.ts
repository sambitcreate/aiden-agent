// Main-process dependency wiring for the Electron-free runtime resolver.

import type { AnthropicMessagesCompat } from "@earendil-works/pi-ai";
import { configStore } from "./config-store.js";
import { resolveModelRuntimeWith, type ResolvedModelRuntime } from "./model-runtime-core.js";
import { catalogProviderSlug } from "./models-catalog-core.js";
import { modelsCatalog } from "./models-catalog.js";
import { providerRegistry } from "./provider-registry.js";
import { secrets } from "./secrets.js";

export type { ResolvedModelRuntime };

export async function resolveModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ResolvedModelRuntime> {
  // Ensure the one-release legacy key migration completes even when a
  // scheduled/background generation runs before Provider Settings is opened.
  await configStore.listProviders();
  const resolvedProviderId = await configStore.resolveProviderId(providerId);
  if (!resolvedProviderId) throw new Error("Choose a provider before starting a generation.");
  providerId = resolvedProviderId;
  if (providerRegistry.isBuiltinProvider(providerId)) {
    await providerRegistry.migrateLegacyApiKeys();
    await providerRegistry.assertBuiltinModelAvailable(providerId, modelId);
  }
  return resolveModelRuntimeWith(
    {
      getProvider: (id) => configStore.getProvider(id),
      getApiKey: (id) => secrets.getKey(id),
      resolveRuntimeLimits: (provider, id) => {
        const piProviderId = catalogProviderSlug(provider.id);
        const piModel = piProviderId
          ? providerRegistry.models.getModel(piProviderId, id)
          : undefined;
        const forceAdaptiveThinking =
          piModel?.api === "anthropic-messages"
            ? (piModel.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking
            : undefined;
        const exact = piModel ? { ...piModel, forceAdaptiveThinking } : undefined;
        return modelsCatalog.runtimeLimits(provider, id, exact);
      },
      codex: providerRegistry.codex,
      native: {
        getProvider: (id) => providerRegistry.builtinProvider(id),
        getModel: (providerId, id) => providerRegistry.getBuiltinModel(providerId, id),
        streamSimple: providerRegistry.streamSimple,
      },
    },
    providerId,
    modelId,
    signal,
  );
}
