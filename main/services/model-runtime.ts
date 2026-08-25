// Main-process dependency wiring for the Electron-free runtime resolver.

import type { AnthropicMessagesCompat, Models } from "@earendil-works/pi-ai";
import { configStore } from "./config-store.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import {
  resolveModelRuntimeWith,
  withPinnedBotProviderAuth,
  type ResolvedModelRuntime,
} from "./model-runtime-core.js";
import { catalogProviderSlug } from "./models-catalog-core.js";
import { modelsCatalog } from "./models-catalog.js";
import { providerRegistry } from "./provider-registry.js";
import { providerConnectionSnapshot } from "./provider-credential-rotation-core.js";
import { secrets } from "./secrets.js";
import { listProvidersWithLegacyPiCredentialMigration } from "./legacy-pi-credential-migration.js";

export type { ResolvedModelRuntime };

/** Preserve Codex credential-generation safeguards behind the Pi Models shape. */
const codexRuntimeModels = new Proxy(providerRegistry.models, {
  get(target, property) {
    if (property === "streamSimple") return providerRegistry.codex.streamSimple;
    if (property === "completeSimple") {
      return (...args: Parameters<Models["completeSimple"]>) =>
        providerRegistry.codex.streamSimple(...args).result();
    }
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as Models;

export async function resolveModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ResolvedModelRuntime> {
  // Ensure the one-release legacy key migration completes even when a
  // scheduled/background generation runs before Provider Settings is opened.
  await listProvidersWithLegacyPiCredentialMigration();
  const resolvedProviderId = await configStore.resolveProviderId(providerId);
  if (!resolvedProviderId) throw new Error("Choose a provider before starting a generation.");
  providerId = resolvedProviderId;
  if (providerRegistry.isBuiltinProvider(providerId)) {
    await providerRegistry.assertBuiltinModelAvailable(providerId, modelId);
  }
  return resolveModelRuntimeWith(
    {
      getProvider: (id) => configStore.getProvider(id),
      getApiKey: (provider) =>
        secrets.getProviderKey(provider.id, JSON.stringify(providerConnectionSnapshot(provider))),
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
      codex: {
        models: codexRuntimeModels,
        prepareRuntimeModel: providerRegistry.codex.prepareRuntimeModel.bind(
          providerRegistry.codex,
        ),
        streamSimple: providerRegistry.codex.streamSimple,
        prepareIsolatedStream: providerRegistry.codex.prepareIsolatedStream.bind(
          providerRegistry.codex,
        ),
      },
      native: {
        models: providerRegistry.models,
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

/** Resolve a Bot runtime with request auth pinned before the final authority revalidation. */
export async function resolveBotModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ResolvedModelRuntime> {
  const runtime = await resolveModelRuntime(providerId, modelId, signal);
  if (
    runtime.provider.id === OPENAI_CODEX_PROVIDER_ID ||
    !providerRegistry.isBuiltinProvider(runtime.provider.id)
  ) {
    return runtime;
  }
  if (signal?.aborted) throw signal.reason;
  const [provider, auth] = await Promise.all([
    Promise.resolve(providerRegistry.models.getProvider(runtime.provider.id)),
    providerRegistry.models.getAuth(runtime.model),
  ]);
  if (!provider || !auth) {
    throw new Error("This Bot's AI connection is no longer configured.");
  }
  if (signal?.aborted) throw signal.reason;
  return withPinnedBotProviderAuth(
    runtime,
    auth,
    provider.streamSimple.bind(provider),
  );
}

/**
 * Resolve stored built-in auth before Bot authority admission. Pi may refresh
 * and persist an expired OAuth credential here; the post-admission runtime
 * resolution then pins the fresh credential without invalidating its own lease.
 */
export async function preflightBotModelAuth(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = await resolveModelRuntime(providerId, modelId, signal);
  if (
    runtime.provider.id === OPENAI_CODEX_PROVIDER_ID ||
    !providerRegistry.isBuiltinProvider(runtime.provider.id)
  ) {
    return;
  }
  if (signal?.aborted) throw signal.reason;
  const auth = await providerRegistry.models.getAuth(runtime.model);
  if (!auth) throw new Error("This Bot's AI connection is no longer configured.");
  if (signal?.aborted) throw signal.reason;
}
