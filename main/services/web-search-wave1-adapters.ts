/**
 * Integration surface for the JSON/API portion of Web Search Wave 1.
 *
 * The central registry intentionally remains the owner of the complete
 * provider map. It can import these factories and spread this object into its
 * main-only adapter map without exposing transport details to the renderer.
 */

import type { WebSearchAdapterFactory } from "./web-search-provider-registry.js";
import { braveWebSearchAdapterFactory } from "./web-search-brave-adapter.js";
import { openAIWebSearchAdapterFactory } from "./web-search-openai-adapter.js";
import { tavilyWebSearchAdapterFactory } from "./web-search-tavily-adapter.js";

export {
  BRAVE_WEB_SEARCH_ENDPOINT,
  BRAVE_WEB_SEARCH_ORIGIN,
  BRAVE_WEB_SEARCH_QUERY_MAX_CHARS,
  BRAVE_WEB_SEARCH_QUERY_MAX_WORDS,
  buildBraveWebSearchRequest,
  braveWebSearchAdapterFactory,
  createBraveWebSearchAdapter,
  parseBraveWebSearchResponse,
  requireBraveWebSearchApiKey,
  type BraveWebSearchApiKeyCredential,
  type BraveWebSearchCredential,
} from "./web-search-brave-adapter.js";
export {
  OPENAI_WEB_SEARCH_ENDPOINT,
  OPENAI_WEB_SEARCH_MODEL,
  OPENAI_WEB_SEARCH_ORIGIN,
  buildOpenAIWebSearchRequest,
  createOpenAIWebSearchAdapter,
  openAIWebSearchAdapterFactory,
  parseOpenAIWebSearchResponse,
  requireOpenAIWebSearchApiKey,
  type OpenAIWebSearchApiKeyCredential,
  type OpenAIWebSearchCredential,
} from "./web-search-openai-adapter.js";
export {
  TAVILY_WEB_SEARCH_ENDPOINT,
  TAVILY_WEB_SEARCH_ORIGIN,
  buildTavilyWebSearchRequest,
  createTavilyWebSearchAdapter,
  parseTavilyWebSearchResponse,
  requireTavilyWebSearchApiKey,
  tavilyWebSearchAdapterFactory,
  type TavilyWebSearchApiKeyCredential,
  type TavilyWebSearchCredential,
} from "./web-search-tavily-adapter.js";
export {
  WEB_SEARCH_API_KEY_MAX_BYTES,
  WEB_SEARCH_API_KEY_MAX_CHARS,
  WEB_SEARCH_JSON_REQUEST_MAX_BYTES,
  WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
  createWebSearchJsonAdapter,
  mapWebSearchJsonHttpError,
  mapWebSearchJsonTransportError,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  readBoundedWebSearchJsonResponse,
  requireWebSearchApiKey,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonParsedResponse,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";

/** Factories are intentionally separate from the central registry definition. */
export const WEB_SEARCH_WAVE1_ADAPTER_FACTORIES: Readonly<
  Record<"openai" | "brave" | "tavily", WebSearchAdapterFactory>
> = Object.freeze({
  openai: openAIWebSearchAdapterFactory,
  brave: braveWebSearchAdapterFactory,
  tavily: tavilyWebSearchAdapterFactory,
});
