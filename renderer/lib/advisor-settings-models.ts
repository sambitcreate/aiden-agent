import type { Provider } from "./types";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import { isNonChatModel } from "../shared/model-eligibility";

export function advisorChatModels(provider: Provider): string[] {
  return provider.models.filter(
    (model) =>
      !isNonChatModel({
        model,
        metadataType: provider.modelMetadata?.[model]?.type,
      }),
  );
}

export function availableAdvisorProviders(providers: readonly Provider[]): Provider[] {
  return providers.flatMap((provider) => {
    if (provider.needsKey && !provider.hasKey) return [];
    const models = advisorChatModels(provider);
    return models.length > 0 ? [{ ...provider, models }] : [];
  });
}

export function supportedAdvisorEfforts(
  provider: Provider | undefined,
  modelId: string,
): Array<Exclude<GenerationThinkingLevel, "off">> {
  const metadata = provider?.modelMetadata?.[modelId];
  const declared = metadata?.thinkingLevels;
  if (declared) {
    return declared.filter(
      (value): value is Exclude<GenerationThinkingLevel, "off"> => value !== "off",
    );
  }
  return metadata?.reasoning === true ? ["low", "medium", "high"] : [];
}
