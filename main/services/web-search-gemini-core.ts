/**
 * Pure request/response contract for Gemini API-key Google Search grounding.
 *
 * This Wave 1 adapter intentionally excludes ADC, gateways, browser cookies,
 * and model-provider auth.  The only credential accepted here is the
 * main-owned Gemini API key, sent in the reviewed header placement.
 */

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";
export const GEMINI_MODEL = "gemini-3.6-flash";
export const GEMINI_API_ENDPOINT = `${GEMINI_ORIGIN}/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent`;
export const MAX_GEMINI_REQUEST_BYTES = 32 * 1024;
export const MAX_GEMINI_RESPONSE_BYTES = 256 * 1024;
export const MAX_GEMINI_RESULT_TITLE_BYTES = 512;
export const MAX_GEMINI_RESULT_URL_BYTES = 2_048;
export const MAX_GEMINI_RESULT_TEXT_BYTES = 4_096;

const MAX_QUERY_CHARACTERS = 2_000;
const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_API_KEY_BYTES = 8 * 1_024;
const MAX_RESULTS = 10;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_CHARACTERS_GLOBAL = /\p{Cc}/gu;

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

export type GeminiErrorCategory =
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "upstream"
  | "network"
  | "timeout"
  | "cancelled"
  | "policy"
  | "invalid_response";

export interface GeminiErrorContract {
  providerId: "gemini";
  category: GeminiErrorCategory;
  fallbackEligible: boolean;
  message: string;
}

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

type JsonRecord = Record<string, unknown>;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function responseBytes(body: string | Uint8Array): number {
  return typeof body === "string" ? utf8ByteLength(body) : body.byteLength;
}

function sliceUtf8(value: string, maximum: number): string {
  if (utf8ByteLength(value) <= maximum) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > maximum) break;
    result += character;
    used += bytes;
  }
  return result;
}

function closedError(category: GeminiErrorCategory): GeminiErrorContract {
  const fallbackEligible =
    category === "rate_limit" ||
    category === "upstream" ||
    category === "network" ||
    category === "timeout" ||
    category === "invalid_response";
  const messages: Record<GeminiErrorCategory, string> = {
    invalid_request: "Gemini rejected the search request.",
    authentication: "Gemini authentication failed.",
    rate_limit: "Gemini search is temporarily rate limited.",
    upstream: "Gemini search is temporarily unavailable.",
    network: "Gemini search could not reach the provider.",
    timeout: "Gemini search timed out.",
    cancelled: "Gemini search was cancelled.",
    policy: "Gemini search was blocked by the network policy.",
    invalid_response: "Gemini returned an invalid response.",
  };
  return Object.freeze({
    providerId: "gemini",
    category,
    fallbackEligible,
    message: messages[category],
  });
}

function normalizedQuery(value: unknown): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new Error(closedError("invalid_request").message);
  }
  const query = value.trim();
  if (!query || codePointLength(query) > MAX_QUERY_CHARACTERS) {
    throw new Error(closedError("invalid_request").message);
  }
  return query;
}

function normalizedResultCount(value: number | undefined): number {
  const count = value ?? 5;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RESULTS) {
    throw new Error(closedError("invalid_request").message);
  }
  return count;
}

function normalizedApiKey(value: unknown): string {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new Error(closedError("authentication").message);
  }
  const key = value.trim();
  if (
    !key ||
    codePointLength(key) > MAX_API_KEY_CHARACTERS ||
    utf8ByteLength(key) > MAX_API_KEY_BYTES
  ) {
    throw new Error(closedError("authentication").message);
  }
  return key;
}

/** Build Gemini's fixed-origin `generateContent` request with Google Search. */
export function buildGeminiRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  apiKeyValue: string | GeminiApiKeyCredential,
): GeminiRequestContract {
  const query = normalizedQuery(queryValue);
  // Google Search grounding does not expose a result-count request field;
  // Aiden applies the common cap while mapping grounding chunks below.
  normalizedResultCount(numResultsValue);
  const rawApiKey =
    typeof apiKeyValue === "string"
      ? apiKeyValue
      : apiKeyValue?.mode === "api-key"
        ? apiKeyValue.apiKey
        : undefined;
  const apiKey = normalizedApiKey(rawApiKey);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: query }] }],
    // Keep this spelling aligned with the audited Pi Web Access integration.
    tools: [{ google_search: {} }],
  });
  if (responseBytes(body) > MAX_GEMINI_REQUEST_BYTES) {
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
  if (typeof status !== "number" || !Number.isSafeInteger(status)) {
    return closedError("invalid_response");
  }
  if (status < 100 || status > 599) return closedError("invalid_response");
  if (status >= 300 && status < 400) return closedError("policy");
  if (status === 401 || status === 403) return closedError("authentication");
  if (status === 408) return closedError("timeout");
  if (status === 429) return closedError("rate_limit");
  if (status >= 400 && status < 500) return closedError("invalid_request");
  if (status >= 500) return closedError("upstream");
  return closedError("invalid_response");
}

export function geminiTransportError(kind: unknown): GeminiErrorContract {
  if (kind === "redirect") return closedError("policy");
  if (kind === "network" || kind === "timeout" || kind === "cancelled") {
    return closedError(kind);
  }
  return closedError("invalid_response");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeResponseBody(body: unknown): string | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  if (responseBytes(body) > MAX_GEMINI_RESPONSE_BYTES) return undefined;
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  return sliceUtf8(normalized, maximum);
}

function safeResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return undefined;
  const url = value.trim();
  if (!url || utf8ByteLength(url) > MAX_GEMINI_RESULT_URL_BYTES) return undefined;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return url;
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
    const url = safeResultUrl(chunk.web.uri);
    if (!url) continue;
    const duplicateResultIndex = results.findIndex((result) => result.url === url);
    if (duplicateResultIndex >= 0) {
      resultIndexByChunk.set(index, duplicateResultIndex);
      continue;
    }
    const title =
      boundedText(chunk.web.title, MAX_GEMINI_RESULT_TITLE_BYTES) || `Source ${index + 1}`;
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
    const text = boundedText(
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
  maximumResults = MAX_RESULTS,
): GeminiParseOutcome {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > MAX_RESULTS) {
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
  const mediaType =
    typeof response.contentType === "string"
      ? response.contentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
  if (mediaType !== undefined && mediaType !== "application/json") {
    return { ok: false, error: closedError("invalid_response") };
  }
  const body = decodeResponseBody(response?.body);
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
