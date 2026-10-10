// Aiden provider ids that map to a models.dev (and Pi) provider. Shared so the
// renderer can tell which providers are catalog-backed: only those may show a
// models.dev list price, because custom and private endpoints can inherit a
// public row's price that doesn't apply to them.

const PROVIDER_SLUG: Readonly<Record<string, string>> = {
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  gemini: "google",
  google: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  xai: "xai",
  mistral: "mistral",
  minimax: "minimax",
  zai: "zai",
  nvidia: "nvidia",
};

/** Map Aiden's stored provider IDs to the shared Pi/models.dev provider IDs. */
export function catalogProviderSlug(providerId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_SLUG, providerId)
    ? PROVIDER_SLUG[providerId]
    : undefined;
}
