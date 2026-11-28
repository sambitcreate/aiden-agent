import type {
  Api,
  Model,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/** Add reviewed transports to a pinned Pi provider without rebuilding its auth contract. */
export function withProviderStreamOverrides(
  provider: Provider,
  overrides: Partial<Record<Api, ProviderStreams>>,
): Provider {
  const streamsFor = (model: Model<Api>) => overrides[model.api];
  return {
    ...provider,
    stream: (model, context, options) =>
      streamsFor(model)?.stream(model, context, options) ??
      provider.stream(model, context, options),
    streamSimple: (model, context, options) =>
      streamsFor(model)?.streamSimple(model, context, options) ??
      provider.streamSimple(model, context, options),
  };
}

const GOOGLE_XHIGH_FALLBACK_LEVELS = ["high", "medium", "low", "minimal"] as const;
const PI_GOOGLE_SUPPORTED_LEVELS = new Set<string>(GOOGLE_XHIGH_FALLBACK_LEVELS);

function isGoogleXHighRequest(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): boolean {
  if (
    options?.reasoning !== "xhigh" ||
    !model.reasoning ||
    (model.api !== "google-generative-ai" && model.api !== "google-vertex")
  ) {
    return false;
  }
  const mapped = model.thinkingLevelMap?.xhigh;
  return typeof mapped === "string" && mapped.toLowerCase() === "xhigh";
}

function googleXHighFallbackLevel(
  model: Model<Api>,
): (typeof GOOGLE_XHIGH_FALLBACK_LEVELS)[number] {
  return (
    GOOGLE_XHIGH_FALLBACK_LEVELS.find((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (mapped === undefined) return true;
      return typeof mapped === "string" && PI_GOOGLE_SUPPORTED_LEVELS.has(mapped.toLowerCase());
    }) ?? "high"
  );
}

function patchGoogleXHighPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const params = payload as Record<string, unknown>;
  const config = params.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return payload;
  const configRecord = config as Record<string, unknown>;
  const thinkingConfig = configRecord.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object" || Array.isArray(thinkingConfig)) {
    return payload;
  }
  const thinkingRecord = thinkingConfig as Record<string, unknown>;
  if ("thinkingBudget" in thinkingRecord && !("thinkingLevel" in thinkingRecord)) {
    return payload;
  }
  return {
    ...params,
    config: {
      ...configRecord,
      thinkingConfig: {
        ...thinkingRecord,
        includeThoughts: true,
        thinkingLevel: "XHIGH",
      },
    },
  };
}

/**
 * Pi 1.5.2's Google adapters map only minimal/low/medium/high even though
 * Gemini 4 Neon/Hydrogen (and pi.dev's remote catalog) declare xhigh -> xhigh
 * and @google/genai passes thinkingConfig through verbatim. Rewrite xhigh on
 * the outbound GenerateContent params until Pi is bumped.
 */
export function adaptGoogleXHighStreamOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions | undefined {
  if (!isGoogleXHighRequest(model, options)) return options;
  const callerOnPayload = options?.onPayload;
  return {
    ...options,
    reasoning: googleXHighFallbackLevel(model),
    onPayload: async (payload, targetModel) => {
      const patched = patchGoogleXHighPayload(payload);
      if (!callerOnPayload) return patched;
      const next = await callerOnPayload(patched, targetModel);
      return next === undefined ? patched : next;
    },
  };
}

function withGoogleXHighCompatibility(provider: Provider): Provider {
  return {
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, adaptGoogleXHighStreamOptions(model, options)),
  };
}

/** Keep pinned Pi providers compatible with newer reviewed transports and capabilities. */
export function withAidenPiCompatibility(provider: Provider): Provider {
  if (provider.id === "opencode-go") {
    return withGoogleXHighCompatibility(
      withProviderStreamOverrides(provider, {
        "openai-responses": openAIResponsesApi(),
      }),
    );
  }
  if (provider.id === "google" || provider.id === "google-vertex" || provider.id === "opencode") {
    return withGoogleXHighCompatibility(provider);
  }
  return provider;
}

export function additionalAidenPiApis(providerId: string): readonly string[] {
  return providerId === "opencode-go" ? ["openai-responses"] : [];
}
