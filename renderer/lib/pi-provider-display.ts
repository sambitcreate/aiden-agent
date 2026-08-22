/**
 * The compact first view of Pi-native connections. Keep this deliberately
 * small: providers Pi adds in the future remain available under More without
 * a renderer release, while the product-selected connections retain a stable
 * order.
 */
export const FEATURED_PI_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "concentrate",
  "openrouter",
  "deepseek",
  "vercel-ai-gateway",
  "opencode",
  "opencode-go",
  "zai-coding-cn",
  "kimi-coding",
] as const;

const featuredProviderIds = new Set<string>(FEATURED_PI_PROVIDER_IDS);

const ONBOARDING_PRIMARY_PROVIDER_IDS = new Set(["openai", "openai-codex", "anthropic"]);

export const PROVIDER_ICON_SLUGS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "apple-foundation-models",
  "azure-openai-responses",
  "cerebras",
  "claude",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "concentrate",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "grok",
  "groq",
  "huggingface",
  "kimi-coding",
  "lmstudio",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "ollama",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
] as const;

export type ProviderIconSlug = (typeof PROVIDER_ICON_SLUGS)[number];

const providerIconSlugs = new Set<string>(PROVIDER_ICON_SLUGS);

const CUSTOM_LM_STUDIO_PROVIDER_ID = /^custom:lmstudio(?:-(?:[2-9]|[1-9]\d+))?$/u;
const CUSTOM_OLLAMA_PROVIDER_ID = /^custom:ollama(?:-(?:[2-9]|[1-9]\d+))?$/u;

const PROVIDER_ICON_ALIASES: Readonly<Record<string, ProviderIconSlug>> = {
  gemini: "google",
  "lm-studio": "lmstudio",
  moonshot: "moonshotai",
};

export function resolveProviderIconSlug(
  providerId: string,
  modelId?: string,
): ProviderIconSlug | undefined {
  const normalizedProviderId = providerId.trim().toLocaleLowerCase();
  const normalizedModelId = modelId?.trim().toLocaleLowerCase() ?? "";

  if (normalizedProviderId === "anthropic" && normalizedModelId.includes("claude")) {
    return "claude";
  }
  if (normalizedProviderId === "xai" && normalizedModelId.includes("grok")) {
    return "grok";
  }
  if (CUSTOM_LM_STUDIO_PROVIDER_ID.test(normalizedProviderId)) return "lmstudio";
  if (CUSTOM_OLLAMA_PROVIDER_ID.test(normalizedProviderId)) return "ollama";

  const alias = PROVIDER_ICON_ALIASES[normalizedProviderId];
  if (alias) return alias;
  return providerIconSlugs.has(normalizedProviderId)
    ? (normalizedProviderId as ProviderIconSlug)
    : undefined;
}

/** Split Pi's changing catalog into a product-curated first view and the rest. */
export function splitPiBuiltinProviders<T extends { id: string }>(
  providers: readonly T[],
): {
  featured: T[];
  more: T[];
} {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const featured = FEATURED_PI_PROVIDER_IDS.flatMap((id) => {
    const provider = providersById.get(id);
    return provider ? [provider] : [];
  });

  return {
    featured,
    more: providers.filter((provider) => !featuredProviderIds.has(provider.id)),
  };
}

/**
 * Every Pi-native option that is not already represented in onboarding's
 * compact first view. Product-curated providers stay first, while newly added
 * Pi providers remain discoverable without a renderer update.
 */
export function getOnboardingMoreProviders<T extends { id: string; isBuiltin?: boolean }>(
  providers: readonly T[],
): T[] {
  const additionalBuiltins = providers.filter(
    (provider) => provider.isBuiltin === true && !ONBOARDING_PRIMARY_PROVIDER_IDS.has(provider.id),
  );
  const { featured, more } = splitPiBuiltinProviders(additionalBuiltins);
  return [...featured, ...more];
}
