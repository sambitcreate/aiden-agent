import { firstVisibleModelForProvider } from "../shared/model-visibility";
import { canUseGeminiChatModel } from "../shared/gemini-usage-scope";
import type { AppSettings, Provider } from "./types";

export function availableChatModel(
  provider: Pick<Provider, "id" | "models" | "defaultModel" | "needsKey" | "hasKey">,
  settings: Pick<AppSettings, "hiddenModelsByProvider" | "geminiUsageScope"> | undefined,
): string | undefined {
  if (
    !settings ||
    (provider.needsKey && !provider.hasKey) ||
    !canUseGeminiChatModel(settings.geminiUsageScope, provider.id)
  )
    return undefined;
  return firstVisibleModelForProvider(settings.hiddenModelsByProvider, provider.id, provider.models, [
    provider.defaultModel,
  ]);
}
