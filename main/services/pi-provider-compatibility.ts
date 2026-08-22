import type { Api, Model, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/** Add reviewed transports to an older pinned Pi provider without rebuilding its auth contract. */
export function withProviderStreamOverrides(
  provider: Provider,
  overrides: Partial<Record<Api, ProviderStreams>>,
): Provider {
  const streamsFor = (model: Model<Api>) => overrides[model.api];
  return {
    ...provider,
    stream: (model, context, options) =>
      streamsFor(model)?.stream(model, context, options) ?? provider.stream(model, context, options),
    streamSimple: (model, context, options) =>
      streamsFor(model)?.streamSimple(model, context, options) ??
      provider.streamSimple(model, context, options),
  };
}

/** Pi 0.80 predates OpenCode Go's Responses-backed models published by pi.dev. */
export function withAidenPiCompatibility(provider: Provider): Provider {
  if (provider.id !== "opencode-go") return provider;
  return withProviderStreamOverrides(provider, {
    "openai-responses": openAIResponsesApi(),
  });
}

export function additionalAidenPiApis(providerId: string): readonly string[] {
  return providerId === "opencode-go" ? ["openai-responses"] : [];
}
