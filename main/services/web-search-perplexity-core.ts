/**
 * Pure request/response contract for Perplexity Sonar's API-key route.
 *
 * Only source citations cross this boundary.  Answer prose and provider
 * diagnostics remain untrusted input and are never used as an error message.
 */

import {
  WEB_SEARCH_RESULTS_MAX_COUNT,
  boundWebSearchText,
  createWebSearchCoreError,
  decodeWebSearchBody,
  isRecord,
  isValidWebSearchResultCount,
  mapWebSearchCoreHttpError,
  mapWebSearchCoreTransportError,
  parseWebSearchMediaType,
  requireWebSearchCoreApiKey,
  requireWebSearchCoreQuery,
  requireWebSearchCoreResultCount,
  validateWebSearchResultUrl,
  webSearchBodyByteLength,
  type WebSearchCoreErrorCategory,
  type WebSearchCoreErrorContract,
} from "./web-search-adapter-kit.js";

export const PERPLEXITY_ORIGIN = "https://api.perplexity.ai";
export const PERPLEXITY_ENDPOINT = `${PERPLEXITY_ORIGIN}/chat/completions`;
export const PERPLEXITY_MODEL = "sonar";
export const MAX_PERPLEXITY_REQUEST_BYTES = 32 * 1024;
export const MAX_PERPLEXITY_RESPONSE_BYTES = 256 * 1024;
export const MAX_PERPLEXITY_RESULT_TITLE_BYTES = 512;
export const MAX_PERPLEXITY_RESULT_URL_BYTES = 2_048;
export const MAX_PERPLEXITY_RESULT_TEXT_BYTES = 4_096;

const PERPLEXITY_LABEL = "Perplexity";

export interface PerplexityRequestContract {
  url: typeof PERPLEXITY_ENDPOINT;
  init: {
    method: "POST";
    redirect: "error";
    credentials: "omit";
    cache: "no-store";
    referrerPolicy: "no-referrer";
    headers: Readonly<Record<string, string>>;
    body: string;
  };
}

export interface PerplexityApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type PerplexityErrorCategory = WebSearchCoreErrorCategory;

export type PerplexityErrorContract = WebSearchCoreErrorContract<"perplexity">;

export interface PerplexityResult {
  title: string;
  url: string;
  text: string;
}

export interface PerplexityEvidence {
  providerId: "perplexity";
  trust: "untrusted-web-evidence";
  results: PerplexityResult[];
}

export type PerplexityParseOutcome =
  | { ok: true; value: PerplexityEvidence }
  | { ok: false; error: PerplexityErrorContract };

export interface PerplexityResponseContract {
  status: number;
  body: string | Uint8Array;
  contentType?: string;
}

type JsonRecord = Record<string, unknown>;

function closedError(category: PerplexityErrorCategory): PerplexityErrorContract {
  return createWebSearchCoreError("perplexity", PERPLEXITY_LABEL, category);
}

/** Build the fixed-origin Perplexity Sonar chat-completions request. */
export function buildPerplexityRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  apiKeyValue: string | PerplexityApiKeyCredential,
): PerplexityRequestContract {
  const query = requireWebSearchCoreQuery(queryValue, "perplexity", PERPLEXITY_LABEL);
  // Validate the requested projection bound even though Sonar's chat
  // completions route does not expose a result-count field.
  requireWebSearchCoreResultCount(numResultsValue, "perplexity", PERPLEXITY_LABEL);
  const rawApiKey =
    typeof apiKeyValue === "string"
      ? apiKeyValue
      : apiKeyValue?.mode === "api-key"
        ? apiKeyValue.apiKey
        : undefined;
  const apiKey = requireWebSearchCoreApiKey(rawApiKey, "perplexity", PERPLEXITY_LABEL);
  const body = JSON.stringify({
    model: PERPLEXITY_MODEL,
    messages: [{ role: "user", content: query }],
    max_tokens: 1_024,
    return_related_questions: false,
  });
  if (webSearchBodyByteLength(body) > MAX_PERPLEXITY_REQUEST_BYTES) {
    throw new Error(closedError("invalid_request").message);
  }
  return Object.freeze({
    url: PERPLEXITY_ENDPOINT,
    init: Object.freeze({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      }),
      body,
    }),
  });
}

export function perplexityHttpError(status: unknown): PerplexityErrorContract {
  return mapWebSearchCoreHttpError("perplexity", PERPLEXITY_LABEL, status);
}

export function perplexityTransportError(kind: unknown): PerplexityErrorContract {
  return mapWebSearchCoreTransportError("perplexity", PERPLEXITY_LABEL, kind);
}

function textValue(value: JsonRecord): string {
  for (const key of ["snippet", "description", "content", "text", "summary"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return "";
}

function titleValue(value: JsonRecord, index: number): string {
  for (const key of ["title", "name"]) {
    if (typeof value[key] === "string" && (value[key] as string).trim()) {
      return boundWebSearchText(value[key], MAX_PERPLEXITY_RESULT_TITLE_BYTES);
    }
  }
  return `Source ${index + 1}`;
}

function addResult(
  results: PerplexityResult[],
  seen: Set<string>,
  value: unknown,
  index: number,
  maximumResults: number,
): void {
  const record = typeof value === "string" ? { url: value } : isRecord(value) ? value : undefined;
  if (!record) return;
  const url = validateWebSearchResultUrl(
    record.url ?? record.link ?? record.source,
    MAX_PERPLEXITY_RESULT_URL_BYTES,
  );
  if (!url || seen.has(url) || results.length >= maximumResults) return;
  seen.add(url);
  results.push({
    title: titleValue(record, index),
    url,
    text: boundWebSearchText(textValue(record), MAX_PERPLEXITY_RESULT_TEXT_BYTES),
  });
}

function parsePayload(payload: unknown, maximumResults: number): PerplexityResult[] | undefined {
  if (!isRecord(payload)) return undefined;
  const results: PerplexityResult[] = [];
  const seen = new Set<string>();
  const searchResults = Array.isArray(payload.search_results)
    ? payload.search_results
    : Array.isArray(payload.results)
      ? payload.results
      : [];
  for (const [index, value] of searchResults.entries()) {
    addResult(results, seen, value, index, maximumResults);
    if (results.length >= maximumResults) break;
  }
  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  for (const [index, value] of citations.entries()) {
    addResult(results, seen, value, results.length + index, maximumResults);
    if (results.length >= maximumResults) break;
  }
  return results.length > 0 ? results : undefined;
}

/** Parse one bounded Perplexity response into attributed source evidence. */
export function parsePerplexityResponse(
  response: PerplexityResponseContract,
  maximumResults = WEB_SEARCH_RESULTS_MAX_COUNT,
): PerplexityParseOutcome {
  if (!isValidWebSearchResultCount(maximumResults)) {
    return { ok: false, error: closedError("invalid_request") };
  }
  if (
    typeof response?.status !== "number" ||
    !Number.isSafeInteger(response.status) ||
    response.status < 200 ||
    response.status >= 300
  ) {
    return { ok: false, error: perplexityHttpError(response?.status) };
  }
  const mediaType = parseWebSearchMediaType(response.contentType);
  if (mediaType !== undefined && mediaType !== "application/json") {
    return { ok: false, error: closedError("invalid_response") };
  }
  const body = decodeWebSearchBody(response?.body, MAX_PERPLEXITY_RESPONSE_BYTES);
  if (body === undefined) return { ok: false, error: closedError("invalid_response") };
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, error: closedError("invalid_response") };
  }
  const results = parsePayload(payload, maximumResults);
  if (!results) return { ok: false, error: closedError("invalid_response") };
  return {
    ok: true,
    value: {
      providerId: "perplexity",
      trust: "untrusted-web-evidence",
      results,
    },
  };
}
