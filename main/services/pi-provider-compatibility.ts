import type {
  Api,
  Model,
  Provider,
  ProviderRequestOptions,
  ProviderStreams,
} from "@earendil-works/pi-ai";
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

const GOOGLE_THINKING_FLOOR_PROVIDER_IDS = new Set(["google", "google-vertex"]);

/**
 * Pi ≤0.85 maps a disabled-thinking request for every Gemini 3 Flash id to
 * `thinkingLevel: "MINIMAL"`. Google removed `minimal` from 3.7 Flash onward —
 * its documented floor is `low` — so the pinned adapter earns a 400 there.
 * Return the replacement floor only for ids that lost `minimal`; Flash-Lite
 * and image variants keep a different level matrix and are not rewritten.
 */
export function googleDisabledThinkingFloor(modelId: string): "LOW" | undefined {
  const id = modelId.toLowerCase().replace(/^models\//u, "");
  if (/(?:lite|image)/u.test(id)) return undefined;
  if (id === "gemini-flash-latest") return "LOW";
  const version = /^gemini-(\d+)(?:\.(\d+))?-flash/u.exec(id);
  if (!version) return undefined;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? "0");
  return major > 3 || (major === 3 && minor >= 7) ? "LOW" : undefined;
}

interface GoogleThinkingPayload {
  config?: {
    thinkingConfig?: {
      thinkingLevel?: string;
      thinkingBudget?: number;
      includeThoughts?: boolean;
    };
  };
}

/**
 * Rewrite only the unsupported disabled-thinking floor. Enabled levels and
 * `includeThoughts` stay untouched, so Aiden's "off" keeps meaning hidden
 * thinking rather than silently exposing thought summaries.
 */
export function floorGoogleDisabledThinkingLevel(
  payload: unknown,
  model: Pick<Model<Api>, "id">,
): unknown {
  const floor = googleDisabledThinkingFloor(model.id);
  if (!floor) return payload;
  const params = payload as GoogleThinkingPayload | null;
  const config = params?.config;
  const thinking = config?.thinkingConfig;
  if (!config || thinking?.thinkingLevel !== "MINIMAL") return payload;
  return {
    ...params,
    config: {
      ...config,
      thinkingConfig: { ...thinking, thinkingLevel: floor },
    },
  };
}

/** Compose the floor repair into the provider's `onPayload` stream option. */
export function withGoogleThinkingFloor(provider: Provider): Provider {
  if (!GOOGLE_THINKING_FLOOR_PROVIDER_IDS.has(provider.id)) return provider;
  const withFloor = <TOptions extends ProviderRequestOptions<Model<Api>> | undefined>(
    options: TOptions,
  ): TOptions =>
    ({
      ...(options ?? {}),
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const floored = floorGoogleDisabledThinkingLevel(payload, model);
        const delegated = await options?.onPayload?.(floored, model);
        return delegated ?? floored;
      },
    }) as TOptions;
  return {
    ...provider,
    stream: (model, context, options) =>
      provider.stream(model, context, withFloor(options)),
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, withFloor(options)),
  };
}

/** Pi 0.80 predates OpenCode Go's Responses-backed models published by pi.dev. */
export function withAidenPiCompatibility(provider: Provider): Provider {
  const floored = withGoogleThinkingFloor(provider);
  if (provider.id !== "opencode-go") return floored;
  return withProviderStreamOverrides(floored, {
    "openai-responses": openAIResponsesApi(),
  });
}

export function additionalAidenPiApis(providerId: string): readonly string[] {
  return providerId === "opencode-go" ? ["openai-responses"] : [];
}
