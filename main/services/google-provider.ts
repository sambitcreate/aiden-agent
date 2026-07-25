import type {
  Api,
  Model,
  Models,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  GOOGLE_PROVIDER_ID,
  LEGACY_GEMINI_PROVIDER_ID,
  migrateLegacyGoogleProviderId,
} from "../../renderer/shared/google-provider.js";
import {
  googleThinkingCanDisable,
  googleThinkingLevelsForModel,
  isGoogleThinkingLevel,
  type GoogleThinkingLevel,
} from "../../renderer/shared/google-thinking.js";
import type {
  AppSettings,
  ProviderModelMetadata,
  StoredProvider,
} from "./types.js";

export {
  GOOGLE_PROVIDER_ID,
  LEGACY_GEMINI_PROVIDER_ID,
  migrateLegacyGoogleProviderId,
};

export const GOOGLE_PROVIDER_LABEL = "Google Gemini";
export const GOOGLE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
export const GOOGLE_DEFAULT_MODEL = "gemini-2.5-flash";

const builtinGoogleModels = getBuiltinModels("google");
const builtinGoogleModelIds = builtinGoogleModels.map((model) => model.id);
const builtinGoogleModelIdSet = new Set(builtinGoogleModelIds);

function googleModelMetadata(model: Model<Api>): ProviderModelMetadata {
  return {
    source: "provider",
    name: model.name,
    type: "llm",
    vision: model.input.includes("image"),
    reasoning: model.reasoning,
    thinkingLevels: googleThinkingLevelsForModel(model),
    thinkingCanDisable: googleThinkingCanDisable(model),
    contextLength: model.contextWindow,
  };
}

export function googleProviderModels(): readonly Model<Api>[] {
  return builtinGoogleModels;
}

export function googleProviderModelIds(): string[] {
  return [...builtinGoogleModelIds];
}

export function googleProviderModelMetadata(): Record<
  string,
  ProviderModelMetadata
> {
  return Object.fromEntries(
    builtinGoogleModels.map((model) => [model.id, googleModelMetadata(model)]),
  );
}

export function parseGoogleThinkingSelection(
  modelIdValue: unknown,
  levelValue: unknown,
): { modelId: string; level: GoogleThinkingLevel } {
  if (typeof modelIdValue !== "string")
    throw new Error("Invalid Google model.");
  const model = builtinGoogleModels.find(
    (candidate) => candidate.id === modelIdValue,
  );
  if (!model?.reasoning)
    throw new Error("This Google model does not support thinking.");
  if (
    !isGoogleThinkingLevel(levelValue) ||
    !googleThinkingLevelsForModel(model).includes(levelValue)
  ) {
    throw new Error(
      "This thinking level is not supported by the selected Google model.",
    );
  }
  return { modelId: modelIdValue, level: levelValue };
}

export function canonicalGoogleProvider(
  existing?: StoredProvider,
): StoredProvider {
  const existingNativeModels =
    existing?.id === GOOGLE_PROVIDER_ID
      ? existing.models.filter((modelId) =>
          builtinGoogleModelIdSet.has(modelId),
        )
      : undefined;
  const models = existingNativeModels ?? googleProviderModelIds();
  const defaultModel =
    existing?.defaultModel && models.includes(existing.defaultModel)
      ? existing.defaultModel
      : models.includes(GOOGLE_DEFAULT_MODEL)
        ? GOOGLE_DEFAULT_MODEL
        : models[0];
  const metadata = googleProviderModelMetadata();
  return {
    id: GOOGLE_PROVIDER_ID,
    kind: "openai",
    label: GOOGLE_PROVIDER_LABEL,
    baseUrl: GOOGLE_BASE_URL,
    models,
    modelMetadata: Object.fromEntries(
      models.map((modelId) => [modelId, metadata[modelId]]),
    ),
    defaultModel,
    needsKey: true,
    deployment: "hosted",
    isPreset: true,
  };
}

interface GoogleProviderConfig {
  providers: StoredProvider[];
  settings: AppSettings;
}

/** Idempotently replace the legacy compatibility preset with Pi's native provider. */
export function migrateGoogleProviderConfig(
  config: GoogleProviderConfig,
): boolean {
  const legacyIndex = config.providers.findIndex(
    (provider) => provider.id === LEGACY_GEMINI_PROVIDER_ID,
  );
  const googleIndex = config.providers.findIndex(
    (provider) => provider.id === GOOGLE_PROVIDER_ID,
  );
  const existing =
    googleIndex >= 0
      ? config.providers[googleIndex]
      : legacyIndex >= 0
        ? config.providers[legacyIndex]
        : undefined;
  const insertionIndex =
    googleIndex >= 0
      ? googleIndex
      : legacyIndex >= 0
        ? legacyIndex
        : config.providers.length;
  const withoutGoogle = config.providers.filter(
    (provider) =>
      provider.id !== GOOGLE_PROVIDER_ID &&
      provider.id !== LEGACY_GEMINI_PROVIDER_ID,
  );
  withoutGoogle.splice(
    Math.min(insertionIndex, withoutGoogle.length),
    0,
    canonicalGoogleProvider(existing),
  );

  const previousProviders = JSON.stringify(config.providers);
  config.providers = withoutGoogle;
  const migratedProviderId = migrateLegacyGoogleProviderId(
    config.settings.lastProviderId,
  );
  const settingsChanged = migratedProviderId !== config.settings.lastProviderId;
  if (settingsChanged) config.settings.lastProviderId = migratedProviderId;
  return (
    settingsChanged || JSON.stringify(config.providers) !== previousProviders
  );
}

/** Move an encrypted legacy entry without ever decrypting it into JavaScript text. */
export function migrateGoogleProviderKeyMap(
  map: Record<string, string>,
): boolean {
  const legacy = map[LEGACY_GEMINI_PROVIDER_ID];
  if (!legacy) return false;
  if (!map[GOOGLE_PROVIDER_ID]) map[GOOGLE_PROVIDER_ID] = legacy;
  delete map[LEGACY_GEMINI_PROVIDER_ID];
  return true;
}

export class GoogleProviderService {
  constructor(private readonly models: Models) {}

  getModel(modelId: string): Model<Api> | undefined {
    const model = this.models.getModel(GOOGLE_PROVIDER_ID, modelId);
    return model?.api === "google-generative-ai" ? model : undefined;
  }

  streamSimple: ProviderStreams["streamSimple"] = (model, context, options) => {
    const provider = this.models.getProvider(GOOGLE_PROVIDER_ID);
    if (!provider)
      throw new Error("Pi's built-in Google provider is unavailable.");
    return provider.streamSimple(model, context, options);
  };
}
