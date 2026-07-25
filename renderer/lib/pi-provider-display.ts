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
  "openrouter",
  "deepseek",
  "vercel-ai-gateway",
  "opencode",
  "opencode-go",
  "zai-coding-cn",
  "kimi-coding",
] as const;

const featuredProviderIds = new Set<string>(FEATURED_PI_PROVIDER_IDS);

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
