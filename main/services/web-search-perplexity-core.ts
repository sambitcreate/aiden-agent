/**
 * Pure request/response contract for Perplexity Sonar's API-key route.
 *
 * Only source citations cross this boundary.  Answer prose and provider
 * diagnostics remain untrusted input and are never used as an error message.
 */

export const PERPLEXITY_ORIGIN = "https://api.perplexity.ai";
export const PERPLEXITY_ENDPOINT = `${PERPLEXITY_ORIGIN}/chat/completions`;
export const PERPLEXITY_MODEL = "sonar";
export const MAX_PERPLEXITY_REQUEST_BYTES = 32 * 1024;
export const MAX_PERPLEXITY_RESPONSE_BYTES = 256 * 1024;
export const MAX_PERPLEXITY_RESULT_TITLE_BYTES = 512;
export const MAX_PERPLEXITY_RESULT_URL_BYTES = 2_048;
export const MAX_PERPLEXITY_RESULT_TEXT_BYTES = 4_096;

const MAX_QUERY_CHARACTERS = 2_000;
const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_API_KEY_BYTES = 8 * 1_024;
const MAX_RESULTS = 10;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_CHARACTERS_GLOBAL = /\p{Cc}/gu;

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

export type PerplexityErrorCategory =
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "upstream"
  | "network"
  | "timeout"
  | "cancelled"
  | "policy"
  | "invalid_response";

export interface PerplexityErrorContract {
  providerId: "perplexity";
  category: PerplexityErrorCategory;
  fallbackEligible: boolean;
  message: string;
}

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

function closedError(category: PerplexityErrorCategory): PerplexityErrorContract {
  const fallbackEligible =
    category === "rate_limit" ||
    category === "upstream" ||
    category === "network" ||
    category === "timeout" ||
    category === "invalid_response";
  const messages: Record<PerplexityErrorCategory, string> = {
    invalid_request: "Perplexity rejected the search request.",
    authentication: "Perplexity authentication failed.",
    rate_limit: "Perplexity search is temporarily rate limited.",
    upstream: "Perplexity search is temporarily unavailable.",
    network: "Perplexity search could not reach the provider.",
    timeout: "Perplexity search timed out.",
    cancelled: "Perplexity search was cancelled.",
    policy: "Perplexity search was blocked by the network policy.",
    invalid_response: "Perplexity returned an invalid response.",
  };
  return Object.freeze({
    providerId: "perplexity",
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

/** Build the fixed-origin Perplexity Sonar chat-completions request. */
export function buildPerplexityRequest(
  queryValue: string,
  numResultsValue: number | undefined,
  apiKeyValue: string | PerplexityApiKeyCredential,
): PerplexityRequestContract {
  const query = normalizedQuery(queryValue);
  // Validate the requested projection bound even though Sonar's chat
  // completions route does not expose a result-count field.
  normalizedResultCount(numResultsValue);
  const rawApiKey =
    typeof apiKeyValue === "string"
      ? apiKeyValue
      : apiKeyValue?.mode === "api-key"
        ? apiKeyValue.apiKey
        : undefined;
  const apiKey = normalizedApiKey(rawApiKey);
  const body = JSON.stringify({
    model: PERPLEXITY_MODEL,
    messages: [{ role: "user", content: query }],
    max_tokens: 1_024,
    return_related_questions: false,
  });
  if (responseBytes(body) > MAX_PERPLEXITY_REQUEST_BYTES) {
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

export function perplexityTransportError(kind: unknown): PerplexityErrorContract {
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
  if (responseBytes(body) > MAX_PERPLEXITY_RESPONSE_BYTES) return undefined;
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function safeResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return undefined;
  const url = value.trim();
  if (!url || utf8ByteLength(url) > MAX_PERPLEXITY_RESULT_URL_BYTES) return undefined;
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

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  return sliceUtf8(normalized, maximum);
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
      return boundedText(value[key], MAX_PERPLEXITY_RESULT_TITLE_BYTES);
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
  const url = safeResultUrl(record.url ?? record.link ?? record.source);
  if (!url || seen.has(url) || results.length >= maximumResults) return;
  seen.add(url);
  results.push({
    title: titleValue(record, index),
    url,
    text: boundedText(textValue(record), MAX_PERPLEXITY_RESULT_TEXT_BYTES),
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
  maximumResults = MAX_RESULTS,
): PerplexityParseOutcome {
  if (!Number.isSafeInteger(maximumResults) || maximumResults < 1 || maximumResults > MAX_RESULTS) {
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
