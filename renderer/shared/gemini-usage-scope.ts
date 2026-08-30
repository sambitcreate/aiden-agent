import { type HiddenModelsByProvider, withProviderPolicyHidden } from "./model-visibility";

export type GeminiUsageScope = "transcription_only" | "models_and_transcription";

/** Legacy persisted sentinel migrated by model-visibility normalization. */
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
  return withProviderPolicyHidden(current, providerId, scope === "transcription_only");
}
