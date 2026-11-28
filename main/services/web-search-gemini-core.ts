/**
 * Pure request/response contract for Gemini API-key Google Search grounding.
 *
 * This Wave 1 adapter intentionally excludes ADC, gateways, browser cookies,
 * and model-provider auth.  The only credential accepted here is the
 * main-owned Gemini API key, sent in the reviewed header placement.
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

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";
export const GEMINI_MODEL = "gemini-3.6-flash";
export const GEMINI_API_ENDPOINT = `${GEMINI_ORIGIN}/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent`;
export const MAX_GEMINI_REQUEST_BYTES = 32 * 1024;
export const MAX_GEMINI_RESPONSE_BYTES = 256 * 1024;
export const MAX_GEMINI_RESULT_TITLE_BYTES = 512;
export const MAX_GEMINI_RESULT_URL_BYTES = 2_048;
export const MAX_GEMINI_RESULT_TEXT_BYTES = 4_096;

const GEMINI_LABEL = "Gemini";

export interface GeminiRequestContract {
  url: typeof GEMINI_API_ENDPOINT;
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

export interface GeminiApiKeyCredential {
  readonly mode: "api-key";
  readonly apiKey: string;
}

export type GeminiErrorCategory = WebSearchCoreErrorCategory;

export type GeminiErrorContract = WebSearchCoreErrorContract<"gemini">;

export interface GeminiResult {
  title: string;
  url: string;
  text: string;
}

export interface GeminiEvidence {
  providerId: "gemini";
  trust: "untrusted-web-evidence";
  results: GeminiResult[];
}

export type GeminiParseOutcome =
  | { ok: true; value: GeminiEvidence }
  | { ok: false; error: GeminiErrorContract };

export interface GeminiResponseContract {
  status: number;
  body: string | Uint8Array;
  contentType?: string;
}

function closedError(category: GeminiErrorCategory): GeminiErrorContract {
  return createWebSearchCoreError("gemini", GEMINI_LABEL, category);
}

/** Build Gemini's fixed-origin `generateContent` request with Google Search. */
export function buildGeminiRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  apiKeyValue: string | GeminiApiKeyCredential,
): GeminiRequestContract {
  const query = requireWebSearchCoreQuery(queryValue, "gemini", GEMINI_LABEL);
  // Google Search grounding does not expose a result-count request field;
  // Aiden applies the common cap while mapping grounding chunks below.
  requireWebSearchCoreResultCount(numResultsValue, "gemini", GEMINI_LABEL);
  const rawApiKey =
    typeof apiKeyValue === "string"
      ? apiKeyValue
      : apiKeyValue?.mode === "api-key"
        ? apiKeyValue.apiKey
        : undefined;
  const apiKey = requireWebSearchCoreApiKey(rawApiKey, "gemini", GEMINI_LABEL);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: query }] }],
    // Keep this spelling aligned with the audited Pi Web Access integration.
    tools: [{ google_search: {} }],
  });
  if (webSearchBodyByteLength(body) > MAX_GEMINI_REQUEST_BYTES) {
    throw new Error(closedError("invalid_request").message);
  }
  return Object.freeze({
    url: GEMINI_API_ENDPOINT,
    init: Object.freeze({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: Object.freeze({
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      }),
      body,
    }),
  });
}

export function geminiHttpError(status: unknown): GeminiErrorContract {
  return mapWebSearchCoreHttpError("gemini", GEMINI_LABEL, status);
}

export function geminiTransportError(kind: unknown): GeminiErrorContract {
  return mapWebSearchCoreTransportError("gemini", GEMINI_LABEL, kind);
}

interface GroundingChunk {
  web?: { uri?: unknown; title?: unknown };
}

interface GroundingSupport {
  segment?: { text?: unknown };
  groundingChunkIndices?: unknown;
}

interface ParsedGroundingChunks {
  results: GeminiResult[];
  /** Map raw grounding-chunk indexes to the compact result array. */
  resultIndexByChunk: Map<number, number>;
}

function parseGroundingChunks(
  value: unknown,
  maximumResults: number,
): ParsedGroundingChunks | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value as unknown as GroundingChunk[];
  const results: GeminiResult[] = [];
  const resultIndexByChunk = new Map<number, number>();
  for (const [index, chunk] of chunks.entries()) {
    if (!isRecord(chunk) || !isRecord(chunk.web)) continue;
    const url = validateWebSearchResultUrl(chunk.web.uri, MAX_GEMINI_RESULT_URL_BYTES);
    if (!url) continue;
    const duplicateResultIndex = results.findIndex((result) => result.url === url);
    if (duplicateResultIndex >= 0) {
      resultIndexByChunk.set(index, duplicateResultIndex);
      continue;
    }
    const title =
      boundWebSearchText(chunk.web.title, MAX_GEMINI_RESULT_TITLE_BYTES) || `Source ${index + 1}`;
    resultIndexByChunk.set(index, results.length);
    results.push({ title, url, text: "" });
    if (results.length >= maximumResults) break;
  }
  return results.length > 0 ? { results, resultIndexByChunk } : undefined;
}

function applyGroundingSupports(
  results: GeminiResult[],
  resultIndexByChunk: ReadonlyMap<number, number>,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  for (const support of value as unknown as GroundingSupport[]) {
    if (!isRecord(support)) continue;
    const text = boundWebSearchText(
      isRecord(support.segment) ? support.segment.text : undefined,
      MAX_GEMINI_RESULT_TEXT_BYTES,
    );
    if (!text || !Array.isArray(support.groundingChunkIndices)) continue;
    for (const index of support.groundingChunkIndices) {
      if (!Number.isSafeInteger(index) || index < 0) continue;
      const result = results[resultIndexByChunk.get(index) ?? -1];
      if (result && !result.text) result.text = text;
    }
  }
}

/** Parse one bounded Gemini grounding response into attributed source evidence. */
export function parseGeminiResponse(
  response: GeminiResponseContract,
  maximumResults = WEB_SEARCH_RESULTS_MAX_COUNT,
): GeminiParseOutcome {
  if (!isValidWebSearchResultCount(maximumResults)) {
    return { ok: false, error: closedError("invalid_request") };
  }
  if (
    typeof response?.status !== "number" ||
    !Number.isSafeInteger(response.status) ||
    response.status < 200 ||
    response.status >= 300
  ) {
    return { ok: false, error: geminiHttpError(response?.status) };
  }
  const mediaType = parseWebSearchMediaType(response.contentType);
  if (mediaType !== undefined && mediaType !== "application/json") {
    return { ok: false, error: closedError("invalid_response") };
  }
  const body = decodeWebSearchBody(response?.body, MAX_GEMINI_RESPONSE_BYTES);
  if (body === undefined) return { ok: false, error: closedError("invalid_response") };
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, error: closedError("invalid_response") };
  }
  if (!isRecord(payload) || !Array.isArray(payload.candidates) || !payload.candidates[0]) {
    return { ok: false, error: closedError("invalid_response") };
  }
  const candidate = payload.candidates[0];
  if (!isRecord(candidate)) return { ok: false, error: closedError("invalid_response") };
  const metadata = isRecord(candidate.groundingMetadata)
    ? candidate.groundingMetadata
    : isRecord(candidate.grounding_metadata)
      ? candidate.grounding_metadata
      : undefined;
  const parsedChunks = parseGroundingChunks(
    metadata?.groundingChunks ?? metadata?.grounding_chunks,
    maximumResults,
  );
  if (!parsedChunks) return { ok: false, error: closedError("invalid_response") };
  applyGroundingSupports(
    parsedChunks.results,
    parsedChunks.resultIndexByChunk,
    metadata?.groundingSupports ?? metadata?.grounding_supports,
  );
  return {
    ok: true,
    value: {
      providerId: "gemini",
      trust: "untrusted-web-evidence",
      results: parsedChunks.results,
    },
  };
}
