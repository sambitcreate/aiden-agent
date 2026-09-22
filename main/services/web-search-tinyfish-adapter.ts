/** TinyFish Search API adapter (API-key mode only). */

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

export const TINYFISH_WEB_SEARCH_ORIGIN = "https://api.search.tinyfish.ai";
/** TinyFish Search is a GET endpoint at the origin; query is encoded in its URL. */
export const TINYFISH_WEB_SEARCH_ENDPOINT = TINYFISH_WEB_SEARCH_ORIGIN;

export interface TinyFishWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type TinyFishWebSearchCredential = TinyFishWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("tinyfish", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("tinyfish", value.apiKey);
  }
  throw webSearchError("auth", "tinyfish");
}

function requestContract(query: string, apiKey: string): WebSearchJsonRequestContract {
  const url = new URL(TINYFISH_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  return Object.freeze({
    url: url.toString(),
    init: Object.freeze({
      method: "GET" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        "X-API-Key": apiKey,
      }),
    }),
  });
}

function buildRequestValues(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: unknown,
): WebSearchJsonRequestContract {
  const { query } = normalizeWebSearchJsonInput("tinyfish", queryValue, numResultsValue);
  return requestContract(query, credentialValue(credential));
}

/** Build the fixed-origin TinyFish Search request without performing I/O. */
export function buildTinyFishWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: TinyFishWebSearchCredential,
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

/** Parse TinyFish's `{ results: [{ title, snippet, url }] }` response. */
export function parseTinyFishWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (
    !Number.isSafeInteger(maximumResults) ||
    maximumResults < 1 ||
    maximumResults > 10 ||
    !isRecord(payload) ||
    !Array.isArray(payload.results)
  ) {
    return undefined;
  }

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
      text: item.snippet,
    });
    if (results.length >= maximumResults) break;
  }
  return { results };
}

const TINYFISH_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "tinyfish",
  endpoint: TINYFISH_WEB_SEARCH_ENDPOINT,
  allowQuery: true,
  quotaStatuses: Object.freeze([402]),
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "tinyfish");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseTinyFishWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createTinyFishWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(TINYFISH_DEFINITION, options);
}

export const tinyFishWebSearchAdapterFactory = createTinyFishWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireTinyFishWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "tinyfish");
}
