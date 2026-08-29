/**
 * Renderer-safe Web Search provider contracts.
 *
 * This module deliberately contains no Electron, filesystem, network, or
 * secret-store dependency.  The main process may enrich these records with
 * adapter factories later, while the renderer can consume the projection
 * without learning an endpoint, header, credential, or implementation name.
 */

/** The concrete provider ids shipped by Pi Web Access (in its registry order). */
export const WEB_SEARCH_PROVIDER_IDS = [
  "openai",
  "brave",
  "parallel",
  "parallel-mcp",
  "tinyfish",
  "search1api",
  "searchinfinity",
  "querit",
  "tavily",
  "firecrawl",
  "jina",
  "searxng",
  "duckduckgo",
  "perplexity",
  "gemini",
  "kimi",
  "exa",
  "serpdive",
  "kagi",
  "ollama",
  "anysearch",
  "xai",
  "brightdata",
  "serpbase",
  "serper",
  "valyu",
  "bocha",
  "xcrawl",
] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

export type WebSearchCredentialKind =
  | "none"
  | "optional-api-key"
  | "api-key"
  | "existing-provider-auth"
  | "endpoint"
  | "endpoint-and-api-key"
  | "api-key-and-zone";

/** Short aliases retained for adapter/contract callers that use the plan's names. */
export type CredentialKind = WebSearchCredentialKind;

export type WebSearchCostClass =
  | "built-in-free"
  | "provider-free"
  | "quota"
  | "paid"
  | "self-hosted";

export type CostClass = WebSearchCostClass;

export type WebSearchCapability =
  | "search"
  | "search-with-content"
  | "domain-filters"
  | "anonymous"
  | "existing-provider-auth"
  | "self-hosted";

export type WebSearchReleaseState = "shipped" | "experimental" | "blocked";

/**
 * Main-owned adapter factories are intentionally represented as an opaque
 * type here.  The core registry never stores or exposes a callable factory;
 * the main-only registry can intersect this metadata with its adapter map.
 */
export type MainOnlyAdapterFactory = (...args: never[]) => unknown;

/** Immutable metadata shared by main and renderer code. */
export interface WebSearchProviderDefinition {
  id: WebSearchProviderId;
  label: string;
  description: string;
  credentialKind: WebSearchCredentialKind;
  costClass: WebSearchCostClass;
  /** Fixed, reviewed origins. Dynamic endpoint providers intentionally use []. */
  fixedOrigins: readonly string[];
  capabilities: readonly WebSearchCapability[];
  privacyUrl: string;
  termsUrl: string;
  adapterVersion: number;
  releaseState: WebSearchReleaseState;
  /** Provider may be selected by a user but is never an implicit route member. */
  explicitOnly: boolean;
  /** True only for the built-in anonymous Exa route. */
  automaticByDefault: boolean;
}

/** Status supplied by main-owned credential/config resolution. */
export type WebSearchProviderConfigurationStatus =
  | "not-required"
  | "needs-setup"
  | "configured"
  | "invalid";

/**
 * Redacted renderer projection.  It has no fixed origins, key metadata,
 * endpoint details, raw errors, or adapter implementation references.
 */
export interface WebSearchProviderRendererMetadata {
  id: WebSearchProviderId;
  label: string;
  description: string;
  credentialKind: WebSearchCredentialKind;
  costClass: WebSearchCostClass;
  capabilities: readonly WebSearchCapability[];
  privacyUrl: string;
  termsUrl: string;
  adapterVersion: number;
  releaseState: WebSearchReleaseState;
  explicitOnly: boolean;
  automaticByDefault: boolean;
  configurationStatus: WebSearchProviderConfigurationStatus;
  ready: boolean;
}

/** Main-only status input used when projecting a durable snapshot. */
export interface WebSearchProviderStatus {
  configurationStatus: WebSearchProviderConfigurationStatus;
  ready: boolean;
}

const provider = (
  definition: Omit<WebSearchProviderDefinition, "id"> & { id: WebSearchProviderId },
): WebSearchProviderDefinition =>
  Object.freeze({
    ...definition,
    fixedOrigins: Object.freeze([...definition.fixedOrigins]),
    capabilities: Object.freeze([...definition.capabilities]),
  });

/*
 * URLs and origin records below are evidence inputs for the adapter phase.  A
 * dynamic/self-hosted provider has no fixed origin until its separately
 * validated endpoint is configured.  Query strings and credentials are
 * deliberately absent from every fixed origin.
 */
const DEFINITIONS: readonly WebSearchProviderDefinition[] = [
  provider({
    id: "openai",
    label: "OpenAI",
    description: "Search through OpenAI's hosted web-search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.openai.com"],
    capabilities: ["search", "search-with-content", "domain-filters", "existing-provider-auth"],
    privacyUrl: "https://openai.com/policies/privacy-policy",
    termsUrl: "https://openai.com/policies/terms-of-use",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "brave",
    label: "Brave Search",
    description: "Search the web through Brave Search's API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.search.brave.com"],
    capabilities: ["search", "search-with-content", "domain-filters"],
    privacyUrl: "https://brave.com/privacy/browser/",
    termsUrl: "https://brave.com/terms-of-use/",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "parallel",
    label: "Parallel",
    description: "Search through Parallel's hosted search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.parallel.ai"],
    capabilities: ["search", "search-with-content", "domain-filters"],
    privacyUrl: "https://parallel.ai/privacy",
    termsUrl: "https://parallel.ai/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "parallel-mcp",
    label: "Parallel MCP",
    description: "Search through Parallel's hosted MCP service.",
    credentialKind: "optional-api-key",
    costClass: "provider-free",
    fixedOrigins: ["https://search.parallel.ai"],
    capabilities: ["search", "search-with-content", "anonymous"],
    privacyUrl: "https://parallel.ai/privacy",
    termsUrl: "https://parallel.ai/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "tinyfish",
    label: "TinyFish",
    description: "Search through TinyFish's hosted web agent service.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.search.tinyfish.ai"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://tinyfish.ai/privacy",
    termsUrl: "https://tinyfish.ai/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "search1api",
    label: "Search1API",
    description: "Search through Search1API's hosted search service.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.search1api.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://search1api.com/privacy-policy",
    termsUrl: "https://search1api.com/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "searchinfinity",
    label: "Searchinfinity",
    description: "Search through BytePlus Search Infinity.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://torchlight.byteintlapi.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://www.byteplus.com/en/privacy",
    termsUrl: "https://www.byteplus.com/en/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "querit",
    label: "Querit",
    description: "Search through Querit's hosted search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.querit.ai"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://www.querit.ai/en/privacy",
    termsUrl: "https://www.querit.ai/en/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "tavily",
    label: "Tavily",
    description: "Search through Tavily's AI-search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.tavily.com"],
    capabilities: ["search", "search-with-content", "domain-filters"],
    privacyUrl: "https://tavily.com/privacy",
    termsUrl: "https://tavily.com/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "firecrawl",
    label: "Firecrawl",
    description: "Search through a reviewed Firecrawl hosted or self-hosted endpoint.",
    credentialKind: "endpoint-and-api-key",
    costClass: "self-hosted",
    fixedOrigins: [],
    capabilities: ["search", "search-with-content", "self-hosted"],
    privacyUrl: "https://www.firecrawl.dev/privacy",
    termsUrl: "https://www.firecrawl.dev/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "jina",
    label: "Jina",
    description: "Search through Jina AI's hosted reader/search service.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://s.jina.ai"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://jina.ai/legal/privacy-policy",
    termsUrl: "https://jina.ai/legal/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "searxng",
    label: "SearXNG",
    description: "Search through an endpoint the user explicitly hosts or selects.",
    credentialKind: "endpoint",
    costClass: "self-hosted",
    fixedOrigins: [],
    capabilities: ["search", "domain-filters", "self-hosted"],
    privacyUrl: "https://docs.searxng.org/",
    termsUrl: "https://docs.searxng.org/",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "duckduckgo",
    label: "DuckDuckGo",
    description: "Search through DuckDuckGo's explicit experimental HTML route.",
    credentialKind: "none",
    costClass: "provider-free",
    fixedOrigins: ["https://html.duckduckgo.com"],
    capabilities: ["search", "anonymous"],
    privacyUrl: "https://duckduckgo.com/privacy",
    termsUrl: "https://duckduckgo.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "perplexity",
    label: "Perplexity",
    description: "Search through Perplexity's hosted API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.perplexity.ai"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://www.perplexity.ai/privacy",
    termsUrl: "https://www.perplexity.ai/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "gemini",
    label: "Gemini",
    description: "Search through Google's Gemini API web-search capability.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://generativelanguage.googleapis.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://policies.google.com/privacy",
    termsUrl: "https://policies.google.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "kimi",
    label: "Kimi",
    description: "Search through Kimi Code Plan's explicitly bound session.",
    credentialKind: "existing-provider-auth",
    costClass: "quota",
    fixedOrigins: ["https://api.kimi.com"],
    capabilities: ["search", "search-with-content", "existing-provider-auth"],
    privacyUrl: "https://www.kimi.com/privacy",
    termsUrl: "https://www.kimi.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "exa",
    label: "Exa",
    description: "Search through Exa's built-in anonymous MCP route or your API key.",
    credentialKind: "optional-api-key",
    costClass: "built-in-free",
    fixedOrigins: ["https://mcp.exa.ai", "https://api.exa.ai"],
    capabilities: ["search", "search-with-content", "anonymous"],
    privacyUrl: "https://exa.ai/privacy-policy",
    termsUrl: "https://exa.ai/terms",
    adapterVersion: 1,
    releaseState: "shipped",
    explicitOnly: false,
    automaticByDefault: true,
  }),
  provider({
    id: "serpdive",
    label: "SERPdive",
    description: "Search through SERPdive's hosted retrieval API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.serpdive.com"],
    capabilities: ["search", "search-with-content", "domain-filters"],
    privacyUrl: "https://serpdive.com/privacy",
    termsUrl: "https://serpdive.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "kagi",
    label: "Kagi",
    description: "Search through Kagi's hosted search API.",
    credentialKind: "api-key",
    costClass: "paid",
    fixedOrigins: ["https://kagi.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://kagi.com/privacy",
    termsUrl: "https://kagi.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "ollama",
    label: "Ollama Cloud",
    description: "Search through Ollama Cloud's hosted web-search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://ollama.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://ollama.com/privacy",
    termsUrl: "https://ollama.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "anysearch",
    label: "AnySearch",
    description: "Search through AnySearch's explicit hosted route.",
    credentialKind: "optional-api-key",
    costClass: "provider-free",
    fixedOrigins: ["https://api.anysearch.com"],
    capabilities: ["search", "anonymous"],
    privacyUrl: "https://anysearch.com/privacy",
    termsUrl: "https://anysearch.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "xai",
    label: "xAI",
    description: "Search through xAI's hosted Responses web-search capability.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.x.ai"],
    capabilities: ["search", "search-with-content", "existing-provider-auth"],
    privacyUrl: "https://x.ai/legal/privacy-policy",
    termsUrl: "https://x.ai/legal/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "brightdata",
    label: "Bright Data",
    description: "Search through Bright Data's explicit SERP route.",
    credentialKind: "api-key-and-zone",
    costClass: "paid",
    fixedOrigins: ["https://api.brightdata.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://brightdata.com/legal/privacy-policy",
    termsUrl: "https://brightdata.com/legal/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "serpbase",
    label: "SerpBase",
    description: "SerpBase requires a reviewed no-secret-in-URL contract before release.",
    credentialKind: "api-key",
    costClass: "paid",
    fixedOrigins: ["https://api.serpbase.dev"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://serpbase.dev/privacy",
    termsUrl: "https://serpbase.dev/terms",
    adapterVersion: 1,
    releaseState: "blocked",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "serper",
    label: "Serper",
    description: "Search through Serper's explicit Google Search API route.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://google.serper.dev"],
    capabilities: ["search", "search-with-content", "domain-filters"],
    privacyUrl: "https://serper.dev/privacy-policy",
    termsUrl: "https://serper.dev/terms-of-service",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "valyu",
    label: "Valyu",
    description: "Search through Valyu's hosted search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.valyu.ai"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://www.valyu.ai/privacy",
    termsUrl: "https://www.valyu.ai/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "bocha",
    label: "Bocha",
    description: "Search through Bocha AI's hosted web-search API.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://api.bochaai.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://bochaai.com/privacy",
    termsUrl: "https://bochaai.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
  provider({
    id: "xcrawl",
    label: "XCrawl",
    description: "Search through XCrawl's explicit hosted SERP route.",
    credentialKind: "api-key",
    costClass: "quota",
    fixedOrigins: ["https://run.xcrawl.com"],
    capabilities: ["search", "search-with-content"],
    privacyUrl: "https://xcrawl.com/privacy",
    termsUrl: "https://xcrawl.com/terms",
    adapterVersion: 1,
    releaseState: "experimental",
    explicitOnly: true,
    automaticByDefault: false,
  }),
] as const;

/** Immutable registry. Every Pi concrete provider id appears exactly once. */
export const WEB_SEARCH_PROVIDER_REGISTRY: readonly WebSearchProviderDefinition[] = Object.freeze([
  ...DEFINITIONS,
]);

/** Registry/catalog aliases used by Settings and adapter contract consumers. */
export const WEB_SEARCH_PROVIDER_DEFINITIONS = WEB_SEARCH_PROVIDER_REGISTRY;
export const WEB_SEARCH_PROVIDER_CATALOG = WEB_SEARCH_PROVIDER_REGISTRY;

const DEFINITIONS_BY_ID = new Map<WebSearchProviderId, WebSearchProviderDefinition>(
  WEB_SEARCH_PROVIDER_REGISTRY.map((definition) => [definition.id, definition]),
);

export function isWebSearchProviderId(value: unknown): value is WebSearchProviderId {
  return typeof value === "string" && DEFINITIONS_BY_ID.has(value as WebSearchProviderId);
}

export function webSearchProviderDefinition(
  providerId: unknown,
): WebSearchProviderDefinition | undefined {
  return isWebSearchProviderId(providerId) ? DEFINITIONS_BY_ID.get(providerId) : undefined;
}

/** Compatibility alias for callers that use the more common `get` naming. */
export const getWebSearchProviderDefinition = webSearchProviderDefinition;

function validStatus(status: WebSearchProviderStatus | undefined): WebSearchProviderStatus {
  if (!status) return { configurationStatus: "needs-setup", ready: false };
  const configurationStatus = ["not-required", "needs-setup", "configured", "invalid"].includes(
    status.configurationStatus,
  )
    ? status.configurationStatus
    : "invalid";
  return { configurationStatus, ready: status.ready === true };
}

/**
 * Project one definition into renderer-safe metadata.  Status is deliberately
 * boolean/categorical: no key prefix, key length/hash, endpoint, or raw error
 * can be represented by this projection.
 */
export function projectWebSearchProviderForRenderer(
  definition: WebSearchProviderDefinition,
  status?: WebSearchProviderStatus,
): WebSearchProviderRendererMetadata {
  const unsafeStatus = validStatus(
    status ??
      (definition.id === "exa"
        ? { configurationStatus: "not-required", ready: true }
        : definition.credentialKind === "none"
          ? { configurationStatus: "not-required", ready: false }
          : undefined),
  );
  const safeStatus: WebSearchProviderStatus =
    definition.releaseState === "blocked"
      ? { configurationStatus: "invalid", ready: false }
      : unsafeStatus;
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    credentialKind: definition.credentialKind,
    costClass: definition.costClass,
    capabilities: Object.freeze([...definition.capabilities]),
    privacyUrl: definition.privacyUrl,
    termsUrl: definition.termsUrl,
    adapterVersion: definition.adapterVersion,
    releaseState: definition.releaseState,
    explicitOnly: definition.explicitOnly,
    automaticByDefault: definition.automaticByDefault,
    configurationStatus: safeStatus.configurationStatus,
    ready: safeStatus.ready,
  });
}

/** Renderer-safe projection for the complete registry. */
export function webSearchProviderRegistryForRenderer(
  statuses?: Partial<Record<WebSearchProviderId, WebSearchProviderStatus>>,
): readonly WebSearchProviderRendererMetadata[] {
  return Object.freeze(
    WEB_SEARCH_PROVIDER_REGISTRY.map((definition) =>
      projectWebSearchProviderForRenderer(definition, statuses?.[definition.id]),
    ),
  );
}

/** Compatibility alias for the renderer projection helper. */
export const projectWebSearchProviderRegistry = webSearchProviderRegistryForRenderer;

function assertSafeUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Web Search ${label} must be an absolute URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Web Search ${label} must be an HTTPS URL without credentials or query data.`);
  }
}

/** Internal invariant check used by tests and by the main registry bootstrap. */
export function assertWebSearchProviderRegistry(): void {
  if (
    new Set(WEB_SEARCH_PROVIDER_REGISTRY.map((definition) => definition.id)).size !==
    WEB_SEARCH_PROVIDER_IDS.length
  ) {
    throw new Error("Web Search provider registry contains duplicate or missing provider ids.");
  }
  for (const providerId of WEB_SEARCH_PROVIDER_IDS) {
    const definition = webSearchProviderDefinition(providerId);
    if (!definition || definition.id !== providerId || definition.adapterVersion < 1) {
      throw new Error(`Web Search provider registry is missing ${providerId}.`);
    }
    if (
      definition.fixedOrigins.some((origin) => {
        try {
          const parsed = new URL(origin);
          return (
            parsed.protocol !== "https:" ||
            parsed.origin !== origin ||
            Boolean(parsed.username || parsed.password || parsed.search || parsed.hash)
          );
        } catch {
          return true;
        }
      })
    ) {
      throw new Error(`Web Search provider ${providerId} has an unsafe fixed origin.`);
    }
    assertSafeUrl(definition.privacyUrl, `${providerId} privacy URL`);
    assertSafeUrl(definition.termsUrl, `${providerId} terms URL`);
  }
}

assertWebSearchProviderRegistry();

/** Credential mode selected by the user for one route entry. */
export type WebSearchCredentialMode =
  | "anonymous"
  | "api-key"
  | "existing-provider-auth"
  | "endpoint";

/** Error categories that are explicitly allowed to continue an automatic route. */
export type WebSearchFallbackKind =
  | "timeout"
  | "network"
  | "quota"
  | "transient"
  | "unsupported"
  | "invalid-response";

export const WEB_SEARCH_FALLBACK_KINDS: readonly WebSearchFallbackKind[] = Object.freeze([
  "transient",
  "quota",
  "network",
  "invalid-response",
  "unsupported",
]);

export const DEFAULT_WEB_SEARCH_FALLBACK_ON: readonly WebSearchFallbackKind[] = Object.freeze([
  ...WEB_SEARCH_FALLBACK_KINDS,
]);

export const MAX_WEB_SEARCH_ROUTE_ENTRIES = WEB_SEARCH_PROVIDER_IDS.length;
export const MAX_WEB_SEARCH_PROVIDER_CONFIGS = WEB_SEARCH_PROVIDER_IDS.length;
export const MAX_WEB_SEARCH_PROVIDER_ENDPOINT_CHARS = 2_048;
export const MAX_WEB_SEARCH_PROVIDER_ZONE_CHARS = 256;
export const WEB_SEARCH_SETTINGS_VERSION = 2 as const;

export interface WebSearchRouteEntry {
  providerId: WebSearchProviderId;
  credentialMode: WebSearchCredentialMode;
}

export interface WebSearchFixedSelection {
  mode: "fixed";
  providerId: WebSearchProviderId;
  credentialMode?: WebSearchCredentialMode;
}

export interface WebSearchAutomaticSelection {
  mode: "automatic";
  route: WebSearchRouteEntry[];
  fallbackOn: WebSearchFallbackKind[];
}

export type WebSearchSelection = WebSearchFixedSelection | WebSearchAutomaticSelection;

/** Only non-secret, provider-specific settings may be persisted here. */
export interface BoundedNonSecretProviderConfig {
  /** Reviewed endpoint for self-hosted providers such as SearXNG/Firecrawl. */
  endpoint?: string;
  /** Bright Data's user-selected SERP zone; never an API key. */
  zone?: string;
}

/** Device-local product preferences. Provider credentials are never members. */
export interface WebSearchSettingsV2 {
  version: typeof WEB_SEARCH_SETTINGS_VERSION;
  enabled: boolean;
  selection: WebSearchSelection;
  providerConfig: Partial<Record<WebSearchProviderId, BoundedNonSecretProviderConfig>>;
}

export interface WebSearchProviderReadiness {
  /** Main-owned encrypted credential exists for the exact provider binding. */
  hasCredential?: boolean;
  /** Existing model-provider auth was explicitly rebound to this provider. */
  hasExistingProviderAuth?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`Web Search ${label} must be a string.`);
  if (hasControlCharacter(value)) {
    throw new Error(`Web Search ${label} is invalid or exceeds its size limit.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`Web Search ${label} is invalid or exceeds its size limit.`);
  }
  return normalized;
}

function normalizeProviderEndpoint(value: unknown, providerId: WebSearchProviderId): string {
  const normalized = normalizeBoundedText(
    value,
    `${providerId} endpoint`,
    MAX_WEB_SEARCH_PROVIDER_ENDPOINT_CHARS,
  );
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Web Search ${providerId} endpoint must be an absolute HTTP(S) URL.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `Web Search ${providerId} endpoint must not contain credentials, query, or fragment data.`,
    );
  }
  // A trailing slash is presentation noise and does not change endpoint
  // identity. Keep the root slash for a bare origin.
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/$/u, parsed.pathname === "/" ? "/" : "");
}

const endpointProviders = new Set<WebSearchProviderId>(["searxng", "firecrawl"]);
const zoneProviders = new Set<WebSearchProviderId>(["brightdata"]);

function normalizeProviderConfig(
  providerId: WebSearchProviderId,
  value: unknown,
): BoundedNonSecretProviderConfig {
  if (!isRecord(value)) {
    throw new Error(`Web Search providerConfig.${providerId} must be an object.`);
  }
  const keys = Object.keys(value);
  const allowed = new Set<string>();
  if (endpointProviders.has(providerId)) allowed.add("endpoint");
  if (zoneProviders.has(providerId)) allowed.add("zone");
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error(`Web Search providerConfig.${providerId} contains an unsupported field.`);
  }
  const normalized: BoundedNonSecretProviderConfig = {};
  if (own(value, "endpoint")) {
    normalized.endpoint = normalizeProviderEndpoint(value.endpoint, providerId);
  }
  if (own(value, "zone")) {
    normalized.zone = normalizeBoundedText(
      value.zone,
      `${providerId} zone`,
      MAX_WEB_SEARCH_PROVIDER_ZONE_CHARS,
    );
  }
  return normalized;
}

function credentialModeAllowed(
  definition: WebSearchProviderDefinition,
  mode: WebSearchCredentialMode,
): boolean {
  switch (definition.credentialKind) {
    case "none":
      return mode === "anonymous";
    case "optional-api-key":
      return mode === "anonymous" || mode === "api-key";
    case "api-key":
      return (
        mode === "api-key" ||
        (mode === "existing-provider-auth" &&
          definition.capabilities.includes("existing-provider-auth"))
      );
    case "existing-provider-auth":
      return mode === "existing-provider-auth";
    case "endpoint":
      return mode === "endpoint";
    case "endpoint-and-api-key":
    case "api-key-and-zone":
      return mode === "api-key";
  }
}

function defaultCredentialMode(providerId: WebSearchProviderId): WebSearchCredentialMode {
  const definition = webSearchProviderDefinition(providerId);
  if (!definition) throw new Error(`Unknown Web Search provider ${providerId}.`);
  switch (definition.credentialKind) {
    case "none":
    case "optional-api-key":
      return "anonymous";
    case "existing-provider-auth":
      return "existing-provider-auth";
    case "endpoint":
      return "endpoint";
    case "api-key":
    case "endpoint-and-api-key":
    case "api-key-and-zone":
      return "api-key";
  }
}

function normalizeCredentialMode(
  value: unknown,
  providerId: WebSearchProviderId,
): WebSearchCredentialMode {
  const mode = value === undefined ? defaultCredentialMode(providerId) : value;
  if (
    mode !== "anonymous" &&
    mode !== "api-key" &&
    mode !== "existing-provider-auth" &&
    mode !== "endpoint"
  ) {
    throw new Error(`Web Search provider ${providerId} has an invalid credential mode.`);
  }
  const definition = webSearchProviderDefinition(providerId);
  if (!definition || !credentialModeAllowed(definition, mode)) {
    throw new Error(`Web Search provider ${providerId} does not support ${String(mode)} mode.`);
  }
  return mode;
}

export function normalizeWebSearchRouteEntry(value: unknown): WebSearchRouteEntry {
  if (!isRecord(value)) throw new Error("Web Search route entries must be objects.");
  if (Object.keys(value).some((key) => key !== "providerId" && key !== "credentialMode")) {
    throw new Error("Web Search route entries contain unsupported fields.");
  }
  const providerId = value.providerId;
  if (!isWebSearchProviderId(providerId)) {
    throw new Error("Web Search route contains an unknown provider.");
  }
  const definition = webSearchProviderDefinition(providerId);
  if (!definition || definition.releaseState === "blocked") {
    throw new Error(`Web Search provider ${providerId} is not available for routing.`);
  }
  return {
    providerId,
    credentialMode: normalizeCredentialMode(value.credentialMode, providerId),
  };
}

export function normalizeWebSearchRoute(value: unknown): WebSearchRouteEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WEB_SEARCH_ROUTE_ENTRIES) {
    throw new Error("Web Search automatic route must contain one to twenty-eight providers.");
  }
  const route: WebSearchRouteEntry[] = [];
  const seen = new Set<WebSearchProviderId>();
  for (const entry of value) {
    const normalized = normalizeWebSearchRouteEntry(entry);
    if (seen.has(normalized.providerId)) {
      throw new Error(
        `Web Search automatic route contains duplicate provider ${normalized.providerId}.`,
      );
    }
    seen.add(normalized.providerId);
    route.push(normalized);
  }
  return route;
}

export function validateWebSearchRoute(route: readonly WebSearchRouteEntry[]): void {
  normalizeWebSearchRoute(route);
}

function normalizeFallbackOn(value: unknown): WebSearchFallbackKind[] {
  const source = value === undefined ? DEFAULT_WEB_SEARCH_FALLBACK_ON : value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("Web Search fallbackOn must be a non-empty array.");
  }
  const result: WebSearchFallbackKind[] = [];
  for (const item of source) {
    if (item !== "timeout" && !WEB_SEARCH_FALLBACK_KINDS.includes(item as WebSearchFallbackKind)) {
      throw new Error(`Web Search fallback category ${String(item)} is not supported.`);
    }
    const kind = item as WebSearchFallbackKind;
    if (!result.includes(kind)) result.push(kind);
  }
  return result;
}

function normalizeSelection(value: unknown): WebSearchSelection {
  if (!isRecord(value) || (value.mode !== "fixed" && value.mode !== "automatic")) {
    throw new Error("Web Search selection must be fixed or automatic.");
  }
  if (value.mode === "fixed") {
    if (
      Object.keys(value).some(
        (key) => key !== "mode" && key !== "providerId" && key !== "credentialMode",
      )
    ) {
      throw new Error("Web Search fixed selection contains unsupported fields.");
    }
    if (!isWebSearchProviderId(value.providerId)) {
      throw new Error("Web Search fixed selection contains an unknown provider.");
    }
    const definition = webSearchProviderDefinition(value.providerId);
    if (!definition || definition.releaseState === "blocked") {
      throw new Error(`Web Search provider ${value.providerId} is not available for selection.`);
    }
    return {
      mode: "fixed",
      providerId: value.providerId,
      credentialMode: normalizeCredentialMode(value.credentialMode, value.providerId),
    };
  }
  if (Object.keys(value).some((key) => key !== "mode" && key !== "route" && key !== "fallbackOn")) {
    throw new Error("Web Search automatic selection contains unsupported fields.");
  }
  return {
    mode: "automatic",
    route: normalizeWebSearchRoute(value.route),
    fallbackOn: normalizeFallbackOn(value.fallbackOn),
  };
}

export function normalizeWebSearchSettings(value: unknown): WebSearchSettingsV2 {
  if (!isRecord(value) || value.version !== WEB_SEARCH_SETTINGS_VERSION) {
    throw new Error("Web Search settings must be version 2.");
  }
  if (
    Object.keys(value).some(
      (key) => !["version", "enabled", "selection", "providerConfig"].includes(key),
    )
  ) {
    throw new Error("Web Search settings contain unsupported fields.");
  }
  if (typeof value.enabled !== "boolean") throw new Error("Web Search enabled must be a boolean.");
  const providerConfig: Partial<Record<WebSearchProviderId, BoundedNonSecretProviderConfig>> = {};
  if (value.providerConfig !== undefined) {
    if (!isRecord(value.providerConfig))
      throw new Error("Web Search providerConfig must be an object.");
    const keys = Object.keys(value.providerConfig);
    if (keys.length > MAX_WEB_SEARCH_PROVIDER_CONFIGS) {
      throw new Error("Web Search providerConfig exceeds its size limit.");
    }
    for (const key of keys) {
      if (!isWebSearchProviderId(key)) throw new Error(`Unknown Web Search provider ${key}.`);
      providerConfig[key] = normalizeProviderConfig(key, value.providerConfig[key]);
    }
  }
  return {
    version: WEB_SEARCH_SETTINGS_VERSION,
    enabled: value.enabled,
    selection: normalizeSelection(value.selection),
    providerConfig,
  };
}

export function parseWebSearchSettings(value: unknown): WebSearchSettingsV2 | null {
  try {
    return normalizeWebSearchSettings(value);
  } catch {
    return null;
  }
}

export function isWebSearchSettingsV2(value: unknown): value is WebSearchSettingsV2 {
  return parseWebSearchSettings(value) !== null;
}

export function freshWebSearchSettings(): WebSearchSettingsV2 {
  return {
    version: WEB_SEARCH_SETTINGS_VERSION,
    enabled: true,
    selection: {
      mode: "automatic",
      route: [{ providerId: "exa", credentialMode: "anonymous" }],
      fallbackOn: [...DEFAULT_WEB_SEARCH_FALLBACK_ON],
    },
    providerConfig: {},
  };
}

/** Compatibility alias for callers that call the fresh state a default. */
export const defaultWebSearchSettings = freshWebSearchSettings;

export function webSearchRouteEntryReady(
  entry: WebSearchRouteEntry,
  providerConfig: BoundedNonSecretProviderConfig | undefined,
  readiness: WebSearchProviderReadiness = {},
): boolean {
  const definition = webSearchProviderDefinition(entry.providerId);
  if (!definition || definition.releaseState === "blocked") return false;
  if (entry.credentialMode === "endpoint" && !providerConfig?.endpoint) return false;
  if (definition.credentialKind === "endpoint-and-api-key" && !providerConfig?.endpoint)
    return false;
  if (definition.credentialKind === "api-key-and-zone" && !providerConfig?.zone) return false;
  if (entry.credentialMode === "api-key" && readiness.hasCredential !== true) return false;
  if (
    entry.credentialMode === "existing-provider-auth" &&
    readiness.hasExistingProviderAuth !== true
  )
    return false;
  return true;
}

export interface WebSearchRouteReadiness {
  providerId: WebSearchProviderId;
  ready: boolean;
  configurationStatus: WebSearchProviderConfigurationStatus;
}

/** Pure readiness projection; no key metadata is accepted or returned. */
export function webSearchRouteReadiness(
  settings: WebSearchSettingsV2,
  statuses: Partial<Record<WebSearchProviderId, WebSearchProviderReadiness>> = {},
): WebSearchRouteReadiness[] {
  const entries =
    settings.selection.mode === "fixed"
      ? [
          {
            providerId: settings.selection.providerId,
            credentialMode: normalizeCredentialMode(
              settings.selection.credentialMode,
              settings.selection.providerId,
            ),
          },
        ]
      : settings.selection.route;
  return entries.map((entry) => {
    const definition = webSearchProviderDefinition(entry.providerId)!;
    const ready = webSearchRouteEntryReady(
      entry,
      settings.providerConfig[entry.providerId],
      statuses[entry.providerId],
    );
    let configurationStatus: WebSearchProviderConfigurationStatus;
    if (definition.credentialKind === "none" || entry.credentialMode === "anonymous") {
      configurationStatus = ready ? "not-required" : "invalid";
    } else if (
      entry.credentialMode === "endpoint" &&
      !settings.providerConfig[entry.providerId]?.endpoint
    ) {
      configurationStatus = "needs-setup";
    } else if (
      entry.credentialMode === "existing-provider-auth" &&
      statuses[entry.providerId]?.hasExistingProviderAuth !== true
    ) {
      configurationStatus = "needs-setup";
    } else if (
      entry.credentialMode === "api-key" &&
      statuses[entry.providerId]?.hasCredential !== true
    ) {
      configurationStatus = "needs-setup";
    } else {
      configurationStatus = ready ? "configured" : "invalid";
    }
    return { providerId: entry.providerId, ready, configurationStatus };
  });
}

export type WebSearchProfileKind = "fresh" | "upgrade";

/** Existing install/onboarding signals used to make migration conservative. */
export interface WebSearchFreshnessEvidence {
  /** Explicit durable discriminator preferred by a future config store. */
  profileKind?: WebSearchProfileKind;
  freshProfile?: boolean;
  isFreshInstall?: boolean;
  profileInitialized?: boolean;
  /** Current local config marker; false is the pre-seeding first-run state. */
  seeded?: boolean;
  install?: { seeded?: boolean; initialized?: boolean };
  /** True when a durable profile/settings document was already present. */
  hasPersistedProfile?: boolean;
  settingsFileExists?: boolean;
  /** Versioned onboarding state from the existing profile settings. */
  onboarding?: unknown;
}

export interface WebSearchMigrationInput extends WebSearchFreshnessEvidence {
  /** Direct legacy field accepted for convenient config-store migration. */
  exaEnabled?: unknown;
  /** Legacy settings envelope, when the caller has not flattened it. */
  legacySettings?: { exaEnabled?: unknown } | null;
  legacy?: { exaEnabled?: unknown } | null;
  /** Already-migrated v2 document, accepted for idempotent startup migration. */
  settings?: unknown;
  webSearch?: unknown;
  /** Main-only boolean derived from the encrypted legacy `exa` secret. */
  hasExaKey?: boolean;
  evidence?: WebSearchFreshnessEvidence;
}

export interface WebSearchMigrationReport {
  settings: WebSearchSettingsV2;
  profileKind: WebSearchProfileKind;
  legacyExaEnabled: boolean | undefined;
  dormantLegacyCredential: boolean;
}

function onboardingLooksFresh(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.outcome === "incomplete" &&
    (value.lastSatisfiedStep === "none" ||
      value.lastSatisfiedStep === "profile" ||
      value.lastSatisfiedStep === "provider")
  );
}

export function classifyWebSearchProfile(
  source: WebSearchFreshnessEvidence | WebSearchMigrationInput | undefined,
): WebSearchProfileKind {
  if (!source) return "upgrade";
  const evidence = "evidence" in source && source.evidence ? source.evidence : source;
  if (evidence.profileKind) return evidence.profileKind;
  if (evidence.freshProfile === true || evidence.isFreshInstall === true) return "fresh";
  if (evidence.profileInitialized === false) return "fresh";
  if (evidence.install?.initialized === false || evidence.install?.seeded === false) return "fresh";
  if (evidence.seeded === false) return "fresh";
  // Onboarding is evidence only when no durable profile/settings exists.  A
  // completed or partially-used existing profile therefore remains an upgrade.
  if (
    onboardingLooksFresh(evidence.onboarding) &&
    evidence.hasPersistedProfile !== true &&
    evidence.settingsFileExists !== true &&
    evidence.seeded !== true &&
    evidence.install?.seeded !== true
  ) {
    return "fresh";
  }
  return "upgrade";
}

function readLegacyExaEnabled(input: WebSearchMigrationInput): boolean | undefined {
  const candidates = [input.exaEnabled, input.legacySettings?.exaEnabled, input.legacy?.exaEnabled];
  const value = candidates.find((candidate) => candidate !== undefined);
  return value === true || value === false ? value : undefined;
}

function legacyMigrationSettings(
  legacyExaEnabled: boolean | undefined,
  profileKind: WebSearchProfileKind,
  hasExaKey: boolean,
): WebSearchSettingsV2 {
  // Explicit false always wins, including on a fresh-looking profile and
  // regardless of whether a dormant key remains in encrypted storage.
  if (legacyExaEnabled === false) {
    return { ...freshWebSearchSettings(), enabled: false };
  }
  // Explicit legacy true is an opt-in. Preserve the old keyed behavior only
  // when a key exists; no-key installs use the anonymous Exa route.
  if (legacyExaEnabled === true && hasExaKey) {
    return {
      ...freshWebSearchSettings(),
      selection: {
        mode: "fixed",
        providerId: "exa",
        credentialMode: "api-key",
      },
    };
  }
  if (legacyExaEnabled === true || profileKind === "fresh") return freshWebSearchSettings();
  // Undefined on an initialized/completed profile is an upgrade, not consent
  // to add a new network recipient. Keep preferences conservative.
  return { ...freshWebSearchSettings(), enabled: false };
}

export function migrateWebSearchSettings(input: WebSearchMigrationInput = {}): WebSearchSettingsV2 {
  const existing =
    input.settings ??
    input.webSearch ??
    (isRecord(input) && input.version === 2 ? input : undefined);
  if (existing !== undefined) {
    const parsed = parseWebSearchSettings(existing);
    if (!parsed) throw new Error("Invalid Web Search settings v2 document.");
    return parsed;
  }
  const legacyExaEnabled = readLegacyExaEnabled(input);
  const profileKind = classifyWebSearchProfile(input);
  return legacyMigrationSettings(legacyExaEnabled, profileKind, input.hasExaKey === true);
}

export function migrateWebSearchSettingsWithReport(
  input: WebSearchMigrationInput = {},
): WebSearchMigrationReport {
  const existing =
    input.settings ??
    input.webSearch ??
    (isRecord(input) && input.version === 2 ? input : undefined);
  if (existing !== undefined) {
    const parsed = parseWebSearchSettings(existing);
    if (!parsed) throw new Error("Invalid Web Search settings v2 document.");
    return {
      settings: parsed,
      profileKind: classifyWebSearchProfile(input),
      legacyExaEnabled: readLegacyExaEnabled(input),
      dormantLegacyCredential: input.hasExaKey === true,
    };
  }
  const legacyExaEnabled = readLegacyExaEnabled(input);
  const profileKind = classifyWebSearchProfile(input);
  return {
    settings: legacyMigrationSettings(legacyExaEnabled, profileKind, input.hasExaKey === true),
    profileKind,
    legacyExaEnabled,
    dormantLegacyCredential: input.hasExaKey === true,
  };
}

/** Legacy naming used by some config-store migrations. */
export const migrateLegacyWebSearchSettings = migrateWebSearchSettings;
