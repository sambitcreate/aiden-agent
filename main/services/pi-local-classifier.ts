import type { ClassifierModel, ClassifierApi, ModelType, ModelTypeMap } from "@earendil-works/pi-ai";
import { classify as classifyLlama } from "@earendil-works/pi-ai/api/llama-cpp-classify";
import { classifierErrorResult } from "@earendil-works/pi-ai/utils/model-operations";
import { validateLocalClassifierPreference } from "../../renderer/shared/local-classifier.js";
import { normalizeProviderBaseUrl } from "./models.js";
import { sameProviderConnection } from "./provider-key-policy.js";
import type { PiModelToolsHost } from "./pi-model-tools.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import type { StoredProvider } from "./types.js";

type OperationModels = PiModelToolsHost["models"];
type LocalModel = ClassifierModel<"llama-cpp-classify">;

/** Strip only the explicitly configured chat route; preserve reverse-proxy prefixes. */
export function localClassifierBaseUrl(baseUrl: string): string {
  return normalizeProviderBaseUrl(baseUrl).replace(/\/chat\/completions$/u, "");
}

function enabled(provider: StoredProvider | undefined): provider is StoredProvider {
  if (!provider || provider.llamaCppClassifierEnabled !== true) return false;
  try { validateLocalClassifierPreference(provider); return true; } catch { return false; }
}
function hasModel(provider: StoredProvider, id: string): boolean {
  const type = provider.modelMetadata?.[id]?.type;
  return provider.models.includes(id) && (type === undefined || type === "llm");
}

/** A request-owned classifier facet. It never modifies Pi's chat or image inventory. */
export function createLocalClassifierModels(deps: {
  models: OperationModels;
  providers: readonly StoredProvider[];
  getProvider(id: string): Promise<StoredProvider | undefined>;
  resolveRuntime(providerId: string, modelId: string, signal?: AbortSignal): Promise<ResolvedModelRuntime>;
  classify?: typeof classifyLlama;
}): { models: OperationModels; isLocalProvider(id: string): boolean } {
  const providers = new Map(deps.providers.filter(enabled).map((p) => [p.id, structuredClone(p)]));
  const entries: LocalModel[] = [];
  for (const provider of providers.values()) {
    for (const id of provider.models.filter((id) => hasModel(provider, id))) {
      entries.push({
        type: "classifier", api: "llama-cpp-classify", provider: provider.id, id,
        name: `${provider.modelMetadata?.[id]?.name ?? id} (llama.cpp classifier)`,
        // URL validation belongs at dispatch too, so invalid external config fails clearly.
        baseUrl: provider.baseUrl, input: ["text"],
        contextWindow: provider.modelMetadata?.[id]?.contextLength ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
  }
  const find = (provider: string, id: string) => entries.find((m) => m.provider === provider && m.id === id);
  async function current(snapshot: StoredProvider, id: string): Promise<StoredProvider> {
    const provider = await deps.getProvider(snapshot.id);
    if (!enabled(provider) || !sameProviderConnection(snapshot, provider) || !hasModel(provider, id)) {
      throw new Error("Local classifier configuration changed. Start a new request after checking the provider settings.");
    }
    return provider;
  }
  const models: OperationModels = {
    async getAvailableOfType<T extends ModelType>(type: T, providerId?: string, options?: Parameters<OperationModels["getAvailableOfType"]>[2]) {
      const base = await deps.models.getAvailableOfType(type, providerId, options);
      if (type !== "classifier") return base;
      const available: LocalModel[] = [];
      for (const model of entries) {
        if (providerId && model.provider !== providerId) continue;
        try { await current(providers.get(model.provider)!, model.id); available.push(structuredClone(model)); } catch { /* Revocation removes inventory immediately. */ }
      }
      // The generic branch is narrowed by the type discriminator above.
      return [...base, ...available] as readonly ModelTypeMap[T][];
    },
    getModelOfType<T extends ModelType>(type: T, provider: string, id: string): ModelTypeMap[T] | undefined {
      const local = type === "classifier" ? find(provider, id) : undefined;
      return local ? structuredClone(local) as ModelTypeMap[T] : deps.models.getModelOfType(type, provider, id);
    },
    generateImages: (...args) => deps.models.generateImages(...args),
    async classify(model: ClassifierModel<ClassifierApi>, context, options) {
      const local = find(model.provider, model.id);
      if (!local && model.api !== "llama-cpp-classify" && !providers.has(model.provider)) {
        return deps.models.classify(model, context, options);
      }
      try {
        if (!local) throw new Error("This local classifier was not enabled for the current request.");
        const snapshot = providers.get(local.provider)!;
        const provider = await current(snapshot, local.id);
        const baseUrl = localClassifierBaseUrl(provider.baseUrl);
        options?.signal?.throwIfAborted();
        const runtime = await deps.resolveRuntime(provider.id, local.id, options?.signal);
        await current(snapshot, local.id);
        options?.signal?.throwIfAborted();
        if (!enabled(runtime.provider) || !sameProviderConnection(provider, runtime.provider) ||
            runtime.model.provider !== provider.id || runtime.model.id !== local.id ||
            localClassifierBaseUrl(runtime.model.baseUrl) !== baseUrl) {
          throw new Error("The resolved local classifier does not match the saved provider connection.");
        }
        if (provider.needsKey && !runtime.apiKey) throw new Error("The local classifier requires a saved API key.");
        // Use only freshly resolved credentials. No chat compatibility placeholder or tool-supplied headers.
        return await (deps.classify ?? classifyLlama)({ ...local, baseUrl, contextWindow: runtime.model.contextWindow }, context, {
          apiKey: provider.needsKey ? runtime.apiKey : undefined,
          headers: provider.needsKey ? runtime.headers : undefined,
          signal: options?.signal, timeoutMs: 30_000, maxRetries: 0,
        });
      } catch (error) {
        return classifierErrorResult(local ?? model, error, options?.signal?.aborted);
      }
    },
  };
  return { models, isLocalProvider: (id) => providers.has(id) };
}
