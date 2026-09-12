import type { Provider } from "./types";

export type OnboardingProviderChoice =
  | "openai-key"
  | "openai-signin"
  | "anthropic"
  | "lmstudio"
  | "ollama"
  | "tailscale"
  | "custom";

export type OnboardingProviderDraft = Omit<Provider, "hasKey" | "legacyIds" | "authMethods">;

export interface OnboardingProviderFields {
  apiKey: string;
  baseUrl: string;
}

export interface OnboardingDiscoveryResult {
  models: string[];
  recommendedModel?: string;
}

const LOCAL_PROVIDER_IDS: Partial<Record<OnboardingProviderChoice, string>> = {
  lmstudio: "custom:lmstudio",
  ollama: "custom:ollama",
};

function providerIntent(provider: Provider): OnboardingProviderDraft {
  const {
    hasKey: _hasKey,
    legacyIds: _legacyIds,
    authMethods: _authMethods,
    ...intentAndCache
  } = provider;
  return intentAndCache;
}

/**
 * Build the connection onboarding will test and save. Reserved local identities
 * reuse the live provider intent exactly; onboarding may refresh their model
 * cache, but must never reset an edited endpoint, protocol, auth, or label.
 */
export function makeOnboardingProvider(
  choice: OnboardingProviderChoice,
  baseUrl: string,
  currentProviders: readonly Provider[] = [],
): OnboardingProviderDraft | null {
  if (choice === "openai-signin" || choice === "custom") return null;
  if (choice === "openai-key") {
    return {
      id: "custom:onboarding-openai",
      kind: "openai",
      label: "OpenAI",
      baseUrl: baseUrl || "https://api.openai.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      defaultModel: "gpt-4.1-mini",
      needsKey: true,
      deployment: "hosted",
    };
  }
  if (choice === "anthropic") {
    return {
      id: "custom:onboarding-anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: baseUrl || "https://api.anthropic.com/v1",
      models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      defaultModel: "claude-sonnet-4-5",
      needsKey: true,
      deployment: "hosted",
    };
  }

  const localProviderId = LOCAL_PROVIDER_IDS[choice];
  if (localProviderId) {
    const existing = currentProviders.find(
      (provider) => provider.id === localProviderId && provider.isBuiltin !== true,
    );
    if (existing) return providerIntent(existing);
    if (choice === "lmstudio") {
      return {
        id: localProviderId,
        kind: "openai",
        label: "LM Studio (local)",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: [],
        needsKey: false,
        deployment: "local",
      };
    }
    return {
      id: localProviderId,
      kind: "openai",
      label: "Ollama (local)",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [],
      needsKey: false,
      deployment: "local",
    };
  }

  return {
    id: "custom:onboarding-tailscale",
    kind: "openai",
    label: "Tailscale model",
    baseUrl,
    models: [],
    needsKey: false,
    deployment: "local",
  };
}

/** Preserve a visible draft only while its own choice stays selected. */
export function fieldsAfterProviderChoiceChange(
  currentChoice: OnboardingProviderChoice | null,
  nextChoice: OnboardingProviderChoice | null,
  fields: OnboardingProviderFields,
): OnboardingProviderFields {
  return currentChoice === nextChoice ? fields : { apiKey: "", baseUrl: "" };
}

/** Keep an existing usable default; otherwise prefer the runtime's transient recommendation. */
export function discoveredDefaultModel(
  provider: OnboardingProviderDraft,
  discovery: OnboardingDiscoveryResult,
): string | undefined {
  if (provider.defaultModel && discovery.models.includes(provider.defaultModel)) {
    return provider.defaultModel;
  }
  if (discovery.recommendedModel && discovery.models.includes(discovery.recommendedModel)) {
    return discovery.recommendedModel;
  }
  return discovery.models[0];
}
