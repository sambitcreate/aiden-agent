/** Ollama Cloud web-search adapter (API-key mode only). */

import {
  createWebSearchJsonAdapter,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  requireWebSearchApiKey,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("ollama", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("ollama", value.apiKey);
  }
  throw webSearchError("auth", "ollama");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({ query, max_results: numResults });
  return Object.freeze({
    url: OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      }),
      body,
    }),
  });
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query, numResults } = normalizeWebSearchJsonInput("ollama", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin Ollama Cloud request without performing I/O. */
export function buildOllamaCloudWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: OllamaCloudWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

function normalizedSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value)) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Parse Ollama Cloud's `{ results: [{ title, url, content }] }` envelope. */
export function parseOllamaCloudWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
    return undefined;
  }
  if (!isRecord(payload) || !Array.isArray(payload.results)) return undefined;

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.results) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: item.title,
      url,
      text: item.content,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
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

/** Validate the provider request credential at a call site without I/O. */
export function requireOllamaCloudWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "ollama");
}

// Keep concise aliases for callers that refer to the hosted provider as Ollama.
export const OLLAMA_WEB_SEARCH_ORIGIN = OLLAMA_CLOUD_WEB_SEARCH_ORIGIN;
export const OLLAMA_WEB_SEARCH_ENDPOINT = OLLAMA_CLOUD_WEB_SEARCH_ENDPOINT;
export const buildOllamaWebSearchRequest = buildOllamaCloudWebSearchRequest;
export const parseOllamaWebSearchResponse = parseOllamaCloudWebSearchResponse;
export const createOllamaWebSearchAdapter = createOllamaCloudWebSearchAdapter;
export const ollamaWebSearchAdapterFactory = ollamaCloudWebSearchAdapterFactory;
export const requireOllamaWebSearchApiKey = requireOllamaCloudWebSearchApiKey;
export type OllamaWebSearchApiKeyCredential = OllamaCloudWebSearchApiKeyCredential;
export type OllamaWebSearchCredential = OllamaCloudWebSearchCredential;
