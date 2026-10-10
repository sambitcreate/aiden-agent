// How Aiden provider ids map onto the public model catalogs. The models.dev
// slug map is shared so the renderer can tell which providers are
// catalog-backed: only those may show a models.dev list price, because custom
// and private endpoints can inherit a public row's price that doesn't apply to
// them.

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

/** OpenRouter/Artificial Analysis author slug for providers that serve one vendor's models directly. */
const OPENROUTER_AUTHOR: Readonly<Record<string, string>> = {
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  google: "google",
  gemini: "google",
  deepseek: "deepseek",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  xai: "x-ai",
  mistral: "mistralai",
  minimax: "minimax",
  zai: "z-ai",
  "zai-coding-cn": "z-ai",
  xiaomi: "xiaomi",
  nvidia: "nvidia",
};

/** The benchmark author whose models an Aiden provider serves directly, if any. */
export function openRouterAuthor(providerId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(OPENROUTER_AUTHOR, providerId)
    ? OPENROUTER_AUTHOR[providerId]
    : undefined;
}

/** A model id's last path segment, lowercased: "OpenAI/GPT-4o" -> "gpt-4o". */
export function modelIdLeaf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}
