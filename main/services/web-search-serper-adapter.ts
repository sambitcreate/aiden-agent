/** Serper Google Search API web-search adapter (API-key mode only). */

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

/** Serper's reviewed hosted API origin. */
export const SERPER_WEB_SEARCH_ORIGIN = "https://google.serper.dev";
export const SERPER_WEB_SEARCH_ENDPOINT = `${SERPER_WEB_SEARCH_ORIGIN}/search`;

export interface SerperWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type SerperWebSearchCredential = SerperWebSearchApiKeyCredential | string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("serper", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("serper", value.apiKey);
  }
  throw webSearchError("auth", "serper");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({ q: query, num: numResults });
  return Object.freeze({
    url: SERPER_WEB_SEARCH_ENDPOINT,
    init: Object.freeze({
      method: "POST" as const,
      redirect: "error" as const,
      credentials: "omit" as const,
      cache: "no-store" as const,
      referrerPolicy: "no-referrer" as const,
      headers: Object.freeze({
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
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
  const { query, numResults } = normalizeWebSearchJsonInput("serper", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin Serper request without performing I/O. */
export function buildSerperWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: SerperWebSearchCredential,
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

/** Parse Serper's `{ organic: [...] }` JSON envelope into source evidence. */
export function parseSerperWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
    return undefined;
  }
  if (!isRecord(payload) || !Array.isArray(payload.organic)) return undefined;

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.organic) {
    if (!isRecord(item)) continue;
    const url = normalizedSourceUrl(item.link);
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

const SERPER_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "serper",
  endpoint: SERPER_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "serper");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseSerperWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createSerperWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(SERPER_DEFINITION, options);
}

export const serperWebSearchAdapterFactory = createSerperWebSearchAdapter;

/** Validate the provider request credential at a call site without I/O. */
export function requireSerperWebSearchApiKey(request: WebSearchAdapterRequest): string {
  return requireWebSearchApiKey(request, "serper");
}
