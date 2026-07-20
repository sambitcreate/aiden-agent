// Shared provider/model resolution for the interactive agent and lightweight
// one-shot model tasks such as generated chat titles.

import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { configStore } from "./config-store.js";
import { resolveRuntimeApiKey } from "./generation-runtime.js";
import { secrets } from "./secrets.js";
import type { StoredProvider } from "./types.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const openaiStreams = openAICompletionsApi();
const anthropicStreams = anthropicMessagesApi();

function streamsFor(api: Api): ProviderStreams {
  return api === "anthropic-messages" ? anthropicStreams : openaiStreams;
}

function apiFor(provider: StoredProvider): Api {
  return provider.kind === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function buildModel(provider: StoredProvider, modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: apiFor(provider),
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

export interface ResolvedModelRuntime {
  provider: StoredProvider;
  model: Model<Api>;
  apiKey: string | undefined;
  streams: ProviderStreams;
}

export async function resolveModelRuntime(
  providerId: string,
  modelId: string,
): Promise<ResolvedModelRuntime> {
  const provider = await configStore.getProvider(providerId);
  if (!provider) throw new Error(`Provider "${providerId}" not found.`);

  const storedApiKey = provider.needsKey ? await secrets.getKey(provider.id) : null;
  const apiKey = resolveRuntimeApiKey(provider, storedApiKey);
  if (provider.needsKey && !apiKey) {
    throw new Error(`No API key set for ${provider.label}. Add one in Settings → Providers.`);
  }

  const model = buildModel(provider, modelId);
  return {
    provider,
    model,
    apiKey,
    streams: streamsFor(model.api),
  };
}
