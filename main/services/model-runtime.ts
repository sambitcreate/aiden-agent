// Main-process dependency wiring for the Electron-free runtime resolver.

import type { AnthropicMessagesCompat, Api, Model, Models } from "@earendil-works/pi-ai";
import { configStore } from "./config-store.js";
import type { StoredProvider } from "./types.js";
import { OPENAI_CODEX_PROVIDER_ID } from "./codex-provider.js";
import {
  buildModel,
  resolveModelRuntimeWith,
  withPinnedBotProviderAuth,
  type ResolvedModelRuntime,
} from "./model-runtime-core.js";
import { catalogProviderSlug } from "./models-catalog-core.js";
import { modelsCatalog } from "./models-catalog.js";
import { withoutMessageThreads } from "./pi-message-threads.js";
import { withOpenCodeSessionAttribution } from "./opencode-session-attribution.js";
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

/** A configured provider's limits, with Pi's exact record (thinking map, adaptive thinking) when Pi knows the model. */
function exactRuntimeLimits(provider: StoredProvider, id: string) {
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
}

export async function resolveModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
  conversationId?: string,
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
      resolveRuntimeLimits: exactRuntimeLimits,
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
    conversationId,
  );
}

/** Resolve a Bot runtime with request auth pinned before the final authority revalidation. */
export async function resolveBotModelRuntime(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
  conversationId?: string,
): Promise<ResolvedModelRuntime> {
  const runtime = await resolveModelRuntime(providerId, modelId, signal, conversationId);
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
  return withPinnedBotProviderAuth(runtime, auth, provider.streamSimple.bind(provider), {
    fetchDeferred: provider.fetchDeferred?.bind(provider),
    cancelDeferred: provider.cancelDeferred?.bind(provider),
  });
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

/**
 * The model record a run of this choice will use, built the way
 * `resolveModelRuntime` builds it (provider aliases, Codex, Pi's exact
 * record and limits) but offline: no credentials, auth or network. Bot model
 * choices check thinking levels against this so the check agrees with the run.
 */
export async function resolveRuntimeModelMetadata(providerId: string, modelId: string): Promise<Model<Api>> {
  const resolvedProviderId = await configStore.resolveProviderId(providerId);
  if (!resolvedProviderId) throw new Error("Saved model metadata is unavailable.");
  if (resolvedProviderId === OPENAI_CODEX_PROVIDER_ID) {
    const model = providerRegistry.codex.getModel(modelId);
    if (!model) throw new Error("Saved model metadata is unavailable.");
    return model;
  }
  if (providerRegistry.builtinProvider(resolvedProviderId)) {
    // Offline hydration of Pi's catalogs (no network), as a run does first.
    await providerRegistry.ensureBuiltinCatalogs();
    const model = providerRegistry.getBuiltinModel(resolvedProviderId, modelId);
    if (!model) throw new Error("Saved model metadata is unavailable.");
    return model;
  }
  const provider = await configStore.getProvider(resolvedProviderId);
  if (!provider || !provider.models.includes(modelId)) throw new Error("Saved model metadata is unavailable.");
  return buildModel(provider, modelId, await exactRuntimeLimits(provider, modelId));
}

/** Offline model metadata only: no credential migration, auth, discovery or provider I/O. */
export async function resolveCompactionModelMetadata(
  providerId: string,
  modelId: string,
  conversationId?: string,
) {
  const native = providerRegistry.getBuiltinModel(providerId, modelId);
  if (native) return withoutMessageThreads(withOpenCodeSessionAttribution(native, conversationId));
  const provider = await configStore.getProvider(providerId);
  if (!provider || !provider.models.includes(modelId))
    throw new Error("Saved model metadata is unavailable.");
  return withoutMessageThreads(withOpenCodeSessionAttribution(
    buildModel(provider, modelId, await modelsCatalog.runtimeLimits(provider, modelId)),
    conversationId,
  ));
}
