/** Ollama Cloud web-search adapter (API-key mode only). */

import { isRecord } from "./web-search-adapter-kit.js";
import {
  collectUniqueWebSearchResults,
  createWebSearchJsonAdapter,
  extractWebSearchApiKeyCredential,
  freezeWebSearchJsonRequest,
  isValidWebSearchResultCount,
  normalizeWebSearchJsonInput,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import type { WebSearchAdapter, WebSearchAdapterRequest } from "./web-search-provider-registry.js";
import { webSearchError } from "./web-search-core.js";

/** Ollama Cloud's reviewed hosted API origin. This is not a local daemon. */
export const OLLAMA_CLOUD_WEB_SEARCH_ORIGIN = "https://ollama.com";
export const OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT = `${OLLAMA_CLOUD_WEB_SEARCH_ORIGIN}/api/web_search`;

export interface OllamaCloudWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type OllamaCloudWebSearchCredential = OllamaCloudWebSearchApiKeyCredential | string;

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("ollama", queryValue, numResultsValue);
  const apiKey = extractWebSearchApiKeyCredential("ollama", credential);
  return freezeWebSearchJsonRequest({
    url: OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, max_results: numResults }),
  });
}

/** Build the fixed-origin Ollama Cloud request without performing I/O. */
export function buildOllamaCloudWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: OllamaCloudWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Ollama Cloud's `{ results: [{ title, url, content }] }` envelope. */
export function parseOllamaCloudWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !isValidWebSearchResultCount(maximumResults) ||
    !isRecord(payload) ||
    !Array.isArray(payload.results)
  ) {
    return undefined;
  }

  return collectUniqueWebSearchResults(payload.results, maximumResults, (item) => ({
    title: item.title,
    text: item.content,
  }));
}

const OLLAMA_CLOUD_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "ollama",
  endpoint: OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "ollama");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseOllamaCloudWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createOllamaCloudWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(OLLAMA_CLOUD_DEFINITION, options);
}

export const ollamaCloudWebSearchAdapterFactory = createOllamaCloudWebSearchAdapter;
