/** Tavily Search API adapter (API-key mode only). */

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

export const TAVILY_WEB_SEARCH_ORIGIN = "https://api.tavily.com";
export const TAVILY_WEB_SEARCH_ENDPOINT = `${TAVILY_WEB_SEARCH_ORIGIN}/search`;

export interface TavilyWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type TavilyWebSearchCredential = TavilyWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("tavily", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("tavily", value.apiKey);
  }
  throw webSearchError("auth", "tavily");
}

function requestContract(body: string, apiKey: string): WebSearchJsonRequestContract {
  return Object.freeze({
    url: TAVILY_WEB_SEARCH_ENDPOINT,
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
  const { query, numResults } = normalizeWebSearchJsonInput("tavily", queryValue, numResultsValue);
  const body = JSON.stringify({
    query,
    search_depth: "basic",
    max_results: numResults,
  });
  return requestContract(body, credentialValue(credential));
}

/** Build the fixed-origin Tavily request without performing I/O. */
export function buildTavilyWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: TavilyWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

function normalizedSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
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

/** Parse Tavily's `{ results: [...] }` JSON envelope. */
export function parseTavilyWebSearchResponse(
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
      text: item.content ?? item.raw_content,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

const TAVILY_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "tavily",
  endpoint: TAVILY_WEB_SEARCH_ENDPOINT,
  quotaStatuses: Object.freeze([432, 433]),
  buildRequest: (request: WebSearchAdapterRequest) =>
    buildRequestValues(request.query, request.numResults, request.credential),
  parse: parseTavilyWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createTavilyWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(TAVILY_DEFINITION, options);
}

export const tavilyWebSearchAdapterFactory = createTavilyWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireTavilyWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "tavily");
}
