import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ProviderHeaders, ProviderStreams } from "@earendil-works/pi-ai";
import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_LABEL,
} from "./codex-provider.js";
import { GOOGLE_PROVIDER_ID } from "./google-provider.js";
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
  apiKey: string | undefined;
  headers: ProviderHeaders | undefined;
  streams: Pick<ProviderStreams, "streamSimple">;
}

export interface ModelRuntimeDependencies {
  getProvider(providerId: string): Promise<StoredProvider | undefined>;
  getApiKey(providerId: string): Promise<string | null>;
  resolveRuntimeLimits(provider: StoredProvider, modelId: string): Promise<RuntimeModelLimits>;
  codex: {
    prepareRuntimeModel(modelId: string, signal?: AbortSignal): Promise<Model<Api>>;
    streamSimple: ProviderStreams["streamSimple"];
  };
  google: {
    getModel(modelId: string): Model<Api> | undefined;
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
      apiKey: undefined,
      headers: undefined,
      streams: { streamSimple: dependencies.codex.streamSimple },
    };
  }

  const provider = await dependencies.getProvider(providerId);
  if (!provider) throw new Error(`Provider "${providerId}" not found.`);
  if (!provider.models.includes(modelId)) {
    throw new Error(
      `Model "${modelId}" is no longer available for ${provider.label}. Choose another model and try again.`,
    );
  }

  const storedApiKey = provider.needsKey ? await dependencies.getApiKey(provider.id) : null;
  const apiKey = resolveRuntimeApiKey(provider, storedApiKey);
  if (provider.needsKey && !apiKey) {
    throw new Error(`No API key set for ${provider.label}. Add one in Settings → Providers.`);
  }

  if (providerId === GOOGLE_PROVIDER_ID) {
    const model = dependencies.google.getModel(modelId);
    if (!model) {
      throw new Error(
        `Model "${modelId}" is not supported by Aiden's native Google connection. Choose another model and try again.`,
      );
    }
    return {
      provider,
      model,
      apiKey,
      headers: undefined,
      streams: { streamSimple: dependencies.google.streamSimple },
    };
  }

  const limits = await dependencies.resolveRuntimeLimits(provider, modelId);
  const model = buildModel(provider, modelId, limits);
  return {
    provider,
    model,
    apiKey,
    headers: resolveRuntimeHeaders(provider),
    streams: streamsFor(model.api),
  };
}
