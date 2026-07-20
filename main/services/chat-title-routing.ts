import type {
  ChatTitleProviderId,
  FoundationModelsConnectionStatus,
} from "./types.js";

export type ChatTitleRoute = "apple-foundation-models" | "chat-model" | "seed-only";

export function resolveChatTitleRoute(
  providerId: ChatTitleProviderId,
  foundationModelsStatus: FoundationModelsConnectionStatus | null,
): ChatTitleRoute {
  if (providerId === "chat-model") return "chat-model";
  if (foundationModelsStatus?.state === "ready") return "apple-foundation-models";
  return providerId === "automatic" ? "chat-model" : "seed-only";
}
