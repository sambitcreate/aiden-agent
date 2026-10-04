/** Kagi Search API web-search adapter (API-key mode only). */

import { isRecord, normalizeWebSearchSourceUrl } from "./web-search-adapter-kit.js";
import {
  createWebSearchJsonAdapter,
  normalizeWebSearchApiKey,
  normalizeWebSearchJsonInput,
  type WebSearchJsonAdapterDefinition,
  type WebSearchJsonAdapterOptions,
  type WebSearchJsonRawResult,
  type WebSearchJsonRequestContract,
} from "./web-search-json-adapter.js";
import type { WebSearchAdapter, WebSearchAdapterRequest } from "./web-search-provider-registry.js";
import { webSearchError } from "./web-search-core.js";

/** Kagi's reviewed hosted API origin. */
export const KAGI_WEB_SEARCH_ORIGIN = "https://kagi.com";
export const KAGI_WEB_SEARCH_ENDPOINT = `${KAGI_WEB_SEARCH_ORIGIN}/api/v1/search`;

export interface KagiWebSearchApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type KagiWebSearchCredential = KagiWebSearchApiKeyCredential | string;

function credentialValue(value: unknown): string {
  if (typeof value === "string") return normalizeWebSearchApiKey("kagi", value);
  if (isRecord(value) && value.mode === "api-key" && typeof value.apiKey === "string") {
    return normalizeWebSearchApiKey("kagi", value.apiKey);
  }
  throw webSearchError("auth", "kagi");
}

function requestContract(
  query: string,
  numResults: number,
  apiKey: string,
): WebSearchJsonRequestContract {
  const body = JSON.stringify({ query, limit: numResults });
  return Object.freeze({
    url: KAGI_WEB_SEARCH_ENDPOINT,
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
  const { query, numResults } = normalizeWebSearchJsonInput("kagi", queryValue, numResultsValue);
  return requestContract(query, numResults, credentialValue(credential));
}

/** Build the fixed-origin Kagi request without performing I/O. */
export function buildKagiWebSearchRequest(
  queryValue: unknown,
  numResultsValue: unknown,
  credential: KagiWebSearchCredential,
): WebSearchJsonRequestContract {
  return buildRequestValues(queryValue, numResultsValue, credential);
}

/** Parse Kagi's v1 `{ data: { search: [...] } }` JSON envelope. */
export function parseKagiWebSearchResponse(
  payload: unknown,
  maximumResults: number,
): { results: readonly WebSearchJsonRawResult[] } | undefined {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > 10) {
    return undefined;
  }
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.search)) {
    return undefined;
  }

  const results: WebSearchJsonRawResult[] = [];
  const seen = new Set<string>();
  for (const item of payload.data.search) {
    if (!isRecord(item)) continue;
    const url = normalizeWebSearchSourceUrl(item.url);
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

const KAGI_DEFINITION: WebSearchJsonAdapterDefinition = Object.freeze({
  providerId: "kagi",
  endpoint: KAGI_WEB_SEARCH_ENDPOINT,
  buildRequest: (request: WebSearchAdapterRequest) => {
    if (request.credentialMode !== "api-key" || request.credential === undefined) {
      throw webSearchError("auth", "kagi");
    }
    return buildRequestValues(request.query, request.numResults, request.credential);
  },
  parse: parseKagiWebSearchResponse,
});

/** Factory consumed by the main-only provider registry integration. */
export function createKagiWebSearchAdapter(
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  return createWebSearchJsonAdapter(KAGI_DEFINITION, options);
}

export const kagiWebSearchAdapterFactory = createKagiWebSearchAdapter;
