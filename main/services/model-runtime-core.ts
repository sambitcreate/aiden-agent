import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type ProviderHeaders,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_LABEL,
} from "./codex-provider.js";
import {
  resolveRuntimeApiKey,
  resolveRuntimeBaseUrl,
  resolveRuntimeHeaders,
} from "./generation-runtime.js";
import type { RuntimeModelLimits } from "./models-catalog-core.js";
import type { StoredProvider } from "./types.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const openaiStreams = openAICompletionsApi();
const anthropicStreams = anthropicMessagesApi();

const codexRuntimeProvider: StoredProvider = {
  id: OPENAI_CODEX_PROVIDER_ID,
  kind: "openai",
  label: OPENAI_CODEX_PROVIDER_LABEL,
  baseUrl: OPENAI_CODEX_BASE_URL,
  models: [],
  needsKey: true,
  isPreset: true,
};

function streamsFor(api: Api): ProviderStreams {
  return api === "anthropic-messages" ? anthropicStreams : openaiStreams;
}

function apiFor(provider: StoredProvider): Api {
  return provider.kind === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function buildModel(
  provider: StoredProvider,
  modelId: string,
  limits: RuntimeModelLimits,
): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: apiFor(provider),
    provider: provider.id,
    baseUrl: resolveRuntimeBaseUrl(provider),
    reasoning: limits.reasoning,
    input: limits.input,
    cost: ZERO_COST,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    thinkingLevelMap: limits.thinkingLevelMap,
    compat:
      provider.kind === "anthropic" && limits.forceAdaptiveThinking
        ? { forceAdaptiveThinking: true }
        : undefined,
  };
}

export interface ResolvedModelRuntime {
  provider: StoredProvider;
  model: Model<Api>;
  /** Owning Pi collection for auth, streaming, and future native Harness operations. */
  models: Models;
  apiKey: string | undefined;
  headers: ProviderHeaders | undefined;
  streams: Pick<ProviderStreams, "streamSimple">;
}

export interface ModelRuntimeDependencies {
  getProvider(providerId: string): Promise<StoredProvider | undefined>;
  getApiKey(provider: StoredProvider): Promise<string | null>;
  resolveRuntimeLimits(provider: StoredProvider, modelId: string): Promise<RuntimeModelLimits>;
  codex: {
    models: Models;
    prepareRuntimeModel(modelId: string, signal?: AbortSignal): Promise<Model<Api>>;
    streamSimple: ProviderStreams["streamSimple"];
  };
  native: {
    models: Models;
    getProvider(providerId: string): StoredProvider | undefined;
    getModel(providerId: string, modelId: string): Model<Api> | undefined;
    streamSimple: ProviderStreams["streamSimple"];
  };
}

/** Electron-free resolver so legacy and OAuth routing stay deterministic under test. */
export async function resolveModelRuntimeWith(
  dependencies: ModelRuntimeDependencies,
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<ResolvedModelRuntime> {
  if (providerId === OPENAI_CODEX_PROVIDER_ID) {
    const model = await dependencies.codex.prepareRuntimeModel(modelId, signal);
    return {
      provider: codexRuntimeProvider,
      model,
      models: dependencies.codex.models,
      apiKey: undefined,
      headers: undefined,
      streams: { streamSimple: dependencies.codex.streamSimple },
    };
  }

  // Pi owns the model record, auth resolution, and stream dispatcher for
  // every built-in provider. Never reconstruct one through /compat or read a
  // legacy Aiden key for this path.
  const nativeProvider = dependencies.native.getProvider(providerId);
  if (nativeProvider) {
    const model = dependencies.native.getModel(providerId, modelId);
    if (!model) {
      throw new Error(
        `Model "${modelId}" is not available through Pi's ${nativeProvider.label} provider. Choose another model and try again.`,
      );
    }
    return {
      provider: nativeProvider,
      model,
      models: dependencies.native.models,
      apiKey: undefined,
      headers: undefined,
      streams: { streamSimple: dependencies.native.streamSimple },
    };
  }

  const provider = await dependencies.getProvider(providerId);
  if (!provider) throw new Error(`Provider "${providerId}" not found.`);
  if (!provider.models.includes(modelId)) {
    throw new Error(
      `Model "${modelId}" is no longer available for ${provider.label}. Choose another model and try again.`,
    );
  }

  const storedApiKey = provider.needsKey ? await dependencies.getApiKey(provider) : null;
  const apiKey = resolveRuntimeApiKey(provider, storedApiKey);
  if (provider.needsKey && !apiKey) {
    throw new Error(`No API key set for ${provider.label}. Add one in Settings → Providers.`);
  }

  const limits = await dependencies.resolveRuntimeLimits(provider, modelId);
  const model = buildModel(provider, modelId, limits);
  const headers = resolveRuntimeHeaders(provider);
  const models = createModels();
  models.setProvider(
    createProvider<Api>({
      id: provider.id,
      name: provider.label,
      baseUrl: model.baseUrl,
      headers,
      models: [model],
      auth: {
        apiKey: {
          name: `${provider.label} runtime key`,
          resolve: async () => ({
            auth: { apiKey, headers },
            source: "Aiden custom provider",
          }),
        },
      },
      api: streamsFor(model.api),
    }),
  );
  return {
    provider,
    model,
    models,
    apiKey,
    headers,
    // Custom endpoints now use the same Pi provider/auth/model composition as
    // built-ins; the compat adapter is only the provider's API implementation.
    streams: { streamSimple: models.streamSimple.bind(models) },
  };
}
