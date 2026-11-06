import type { Provider } from "./types";

export type LocalRuntime = "lmstudio" | "ollama";

export type OnboardingProviderDraft = Omit<Provider, "hasKey" | "legacyIds" | "authMethods">;

export interface OnboardingDiscoveryResult {
  models: string[];
  recommendedModel?: string;
}

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
export function localProviderDraft(runtime: LocalRuntime, providers: readonly Provider[] = []): OnboardingProviderDraft {
  const id = `custom:${runtime}`;
  const existing = providers.find(p => p.id === id && !p.isBuiltin);
  if (existing) return providerIntent(existing);
  return {
    id,
    kind: "openai",
    label: runtime === "lmstudio" ? "LM Studio (local)" : "Ollama (local)",
    baseUrl: runtime === "lmstudio" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:11434/v1",
    models: [],
    needsKey: false,
    deployment: "local",
  };
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

export function onboardingModelDescription(platform: string): string {
  const providers = platform === "darwin"
    ? "30+ Pi providers, ChatGPT sign-in, Apple models, or custom endpoints"
    : "30+ Pi providers, ChatGPT sign-in, or custom endpoints";
  return `Choose from ${providers}. Enable local llama.cpp classification in a custom provider’s Advanced panel under Model options. Configured classifiers evaluate structured data after you approve sending it; provider charges may apply.`;
}

/** Platform filtering must preserve setup and privacy disclosures for available features. */
export function visibleOnboardingFeatures<T extends { id: string; description: string }>(
  features: readonly T[],
  capabilities: { computerUse: boolean; bots: boolean; botComputers: boolean; platform: string },
): T[] {
  return features.filter((feature) =>
    (capabilities.computerUse || feature.id !== "computerUse") &&
    (capabilities.bots || feature.id !== "bots") &&
    // A Bot's own macOS VM needs Apple silicon, and a Bot to give it to.
    ((capabilities.botComputers && capabilities.bots) || feature.id !== "botComputers"),
  ).map((feature) => feature.id === "models"
    ? { ...feature, description: onboardingModelDescription(capabilities.platform) }
    : feature.id === "commands" && capabilities.platform === "linux"
    ? { ...feature, description: "Use Ctrl-K or / for app commands, and $ to attach a reusable skill." }
    : feature);
}
