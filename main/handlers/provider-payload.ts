// Renderer provider payload parsing for the providers IPC handlers. Kept free
// of Electron and credential services so the save path can be exercised directly.

import { validateLocalClassifierPreference } from "../../renderer/shared/local-classifier.js";
import { parseCustomModelOptions } from "../../renderer/shared/custom-model-options.js";
import type { ProviderArtwork } from "../../renderer/shared/provider-artwork.js";
import { assertOnboardingTailnetBaseUrl, normalizeProviderBaseUrl } from "../services/models.js";
import { canonicalGoogleProvider, GOOGLE_PROVIDER_ID } from "../services/google-provider.js";
import type {
  ProviderDeployment,
  ProviderKind,
  ProviderModelMetadata,
  ProviderModelType,
  StoredProvider,
} from "../services/types.js";
import { MAX_CONFIG_ID_LENGTH, MAX_PROVIDER_BASE_URL_LENGTH } from "../services/types.js";

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for "${name}".`);
  }
  return value;
}

export function asProviderId(value: unknown): string {
  const id = asString(value, "id");
  if (id.length > MAX_CONFIG_ID_LENGTH) {
    throw new Error(`Expected "id" to be at most ${MAX_CONFIG_ID_LENGTH} characters.`);
  }
  return id;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalModelType(value: unknown): ProviderModelType | undefined {
  return value === "llm" ||
    value === "embedding" ||
    value === "reranker" ||
    value === "image" ||
    value === "audio" ||
    value === "video"
    ? value
    : undefined;
}

function parseModelMetadata(value: unknown): Record<string, ProviderModelMetadata> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: Array<[string, ProviderModelMetadata]> = [];
  for (const [modelId, raw] of Object.entries(value)) {
    if (!modelId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const metadata = raw as Record<string, unknown>;
    const source =
      metadata.source === "lmstudio" ||
      metadata.source === "ollama" ||
      metadata.source === "provider"
        ? metadata.source
        : "provider";
    entries.push([
      modelId,
      {
        source,
        overrides: parseCustomModelOptions(metadata.overrides),
        manuallyAdded: metadata.manuallyAdded === true ? true : undefined,
        name: typeof metadata.name === "string" && metadata.name ? metadata.name : undefined,
        type: optionalModelType(metadata.type),
        vision: typeof metadata.vision === "boolean" ? metadata.vision : undefined,
        toolCall: typeof metadata.toolCall === "boolean" ? metadata.toolCall : undefined,
        reasoning: typeof metadata.reasoning === "boolean" ? metadata.reasoning : undefined,
        contextLength: optionalPositiveNumber(metadata.contextLength),
        parameterCount:
          typeof metadata.parameterCount === "string" && metadata.parameterCount
            ? metadata.parameterCount
            : undefined,
        format:
          typeof metadata.format === "string" && metadata.format ? metadata.format : undefined,
      },
    ]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export interface ProviderPayloadParserDependencies {
  /** Validate or re-encode renderer-supplied artwork; undefined drops it. */
  persistableArtwork(value: unknown): ProviderArtwork | undefined;
}

/** Parse a renderer provider payload into the shape `providers:save/test/listModels` act on. */
export function createProviderPayloadParser(
  deps: ProviderPayloadParserDependencies,
): (value: unknown) => StoredProvider {
  return (value) => parseProvider(value, deps);
}

function parseProvider(value: unknown, deps: ProviderPayloadParserDependencies): StoredProvider {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid provider payload.");
  }
  const p = value as Record<string, unknown>;
  const kind = p.kind === "anthropic" ? "anthropic" : ("openai" as ProviderKind);
  const modelMetadata = parseModelMetadata(p.modelMetadata);
  const models = Array.isArray(p.models)
    ? p.models.filter(
        (model): model is string =>
          typeof model === "string" &&
          (modelMetadata?.[model]?.type === undefined || modelMetadata[model]?.type === "llm"),
      )
    : [];
  const defaultModel =
    typeof p.defaultModel === "string" && models.includes(p.defaultModel)
      ? p.defaultModel
      : undefined;
  const deployment: ProviderDeployment | undefined =
    p.deployment === "local" || p.deployment === "hosted" ? p.deployment : undefined;
  const baseUrl = normalizeProviderBaseUrl(asString(p.baseUrl, "baseUrl"));
  if (baseUrl.length > MAX_PROVIDER_BASE_URL_LENGTH) {
    throw new Error(`Expected "baseUrl" to be at most ${MAX_PROVIDER_BASE_URL_LENGTH} characters.`);
  }
  const provider: StoredProvider = {
    id: asProviderId(p.id),
    kind,
    label: asString(p.label, "label"),
    artwork: deps.persistableArtwork(p.artwork),
    baseUrl,
    models,
    modelMetadata,
    defaultModel,
    needsKey: typeof p.needsKey === "boolean" ? p.needsKey : true,
    deployment,
    llamaCppClassifierEnabled: p.llamaCppClassifierEnabled as boolean | undefined,
    isPreset: typeof p.isPreset === "boolean" ? p.isPreset : false,
    // Built-in status is derived exclusively from Pi's registry, never from
    // a renderer payload that could redirect native credentials.
    isBuiltin: false,
  };
  validateLocalClassifierPreference(provider);
  if (provider.id === "custom:onboarding-tailscale") {
    assertOnboardingTailnetBaseUrl(provider.baseUrl);
  }
  return provider.id === GOOGLE_PROVIDER_ID ? canonicalGoogleProvider(provider) : provider;
}
