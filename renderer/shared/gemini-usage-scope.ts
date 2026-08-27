import { normalizeHiddenModelsByProvider, type HiddenModelsByProvider } from "./model-visibility";

export type GeminiUsageScope = "transcription_only" | "models_and_transcription";

/**
 * A visibility sentinel paired with the execution policy below: existing
 * chats may still execute their pinned Google model, while every current and
 * future Google model stays out of new model selectors.
 */
export const ALL_PROVIDER_MODELS = "*";

export function isGeminiUsageScope(value: unknown): value is GeminiUsageScope {
  return value === "transcription_only" || value === "models_and_transcription";
}

/** Transcription-only is an execution policy, with one explicit legacy-chat exception. */
export function canUseGeminiChatModel(
  scope: GeminiUsageScope | undefined,
  providerId: string,
  allowExistingPinnedChat = false,
): boolean {
  return providerId !== "google" || scope !== "transcription_only" || allowExistingPinnedChat;
}

/** Existing configured users keep the chat-model access they had before scopes existed. */
export function defaultGeminiUsageScope(
  stored: GeminiUsageScope | undefined,
  hasKey: boolean,
): GeminiUsageScope {
  return stored ?? (hasKey ? "models_and_transcription" : "transcription_only");
}

export function hiddenModelsForGeminiScope(
  current: HiddenModelsByProvider | undefined,
  providerId: string,
  scope: GeminiUsageScope,
): HiddenModelsByProvider | undefined {
  const normalized = normalizeHiddenModelsByProvider(current) ?? {};
  const providerModels = new Set(normalized[providerId] ?? []);
  if (scope === "transcription_only") providerModels.add(ALL_PROVIDER_MODELS);
  else providerModels.delete(ALL_PROVIDER_MODELS);

  const next = { ...normalized };
  if (providerModels.size > 0) next[providerId] = [...providerModels];
  else delete next[providerId];
  return normalizeHiddenModelsByProvider(next);
}
