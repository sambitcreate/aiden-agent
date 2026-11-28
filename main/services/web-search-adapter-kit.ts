/** Shared pure parsing, validation, error-mapping, and MCP helpers for web-search modules. */

import { isRecord } from "../shared/guards.js";
import type { WebSearchErrorKind } from "./web-search-core.js";

export { isRecord };

export type WebSearchLengthUnit = "bytes" | "code-points";

export const WEB_SEARCH_QUERY_MAX_CHARACTERS = 2_000;
export const WEB_SEARCH_QUERY_MAX_UTF8_BYTES = 8_192;
export const WEB_SEARCH_RESULTS_DEFAULT_COUNT = 5;
export const WEB_SEARCH_RESULTS_MAX_COUNT = 10;
export const WEB_SEARCH_API_KEY_MAX_CHARACTERS = 4_096;
export const WEB_SEARCH_API_KEY_MAX_UTF8_BYTES = 8_192;
export const WEB_SEARCH_MCP_MAX_SSE_EVENTS = 64;

const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTROL_CHARACTERS_GLOBAL = /\p{Cc}/gu;
const UTF8_ENCODER = new TextEncoder();

export function hasWebSearchControlCharacter(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function webSearchBodyByteLength(body: string | Uint8Array): number {
  return typeof body === "string" ? utf8ByteLength(body) : body.byteLength;
}

export function sliceCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

export function sliceUtf8(value: string, maximum: number): string {
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

export function boundWebSearchText(
  value: unknown,
  maximum: number,
  unit: WebSearchLengthUnit = "bytes",
): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  return unit === "code-points"
    ? sliceCodePoints(normalized, maximum)
    : sliceUtf8(normalized, maximum);
}

export function parseWebSearchMediaType(contentType: unknown): string | undefined {
  return typeof contentType === "string"
    ? contentType.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
}

export function decodeWebSearchBody(body: unknown, maximumBytes: number): string | undefined {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return undefined;
  if (webSearchBodyByteLength(body) > maximumBytes) return undefined;
  if (typeof body === "string") return body;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function parseCredentialFreeHttpUrl(value: unknown): { trimmed: string; parsed: URL } | undefined {
  if (typeof value !== "string" || hasWebSearchControlCharacter(value)) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return { trimmed, parsed };
  } catch {
    return undefined;
  }
}

/**
 * Accept a provider-supplied result URL only when it is a credential-free
 * http(s) URL. Control characters are rejected before parsing because the
 * WHATWG URL parser silently strips tabs and newlines, which would let a
 * hostile provider smuggle a different URL past the displayed value.
 */
export function normalizeWebSearchSourceUrl(value: unknown): string | undefined {
  return parseCredentialFreeHttpUrl(value)?.parsed.toString();
}

/**
 * Validate a standalone-core result URL against a byte or code-point cap and
 * return the trimmed raw URL string without WHATWG canonicalization.
 */
export function validateWebSearchResultUrl(
  value: unknown,
  maximumLength: number,
  unit: WebSearchLengthUnit = "bytes",
): string | undefined {
  const candidate = parseCredentialFreeHttpUrl(value);
  if (!candidate) return undefined;
  const length =
    unit === "code-points" ? codePointLength(candidate.trimmed) : utf8ByteLength(candidate.trimmed);
  return length <= maximumLength ? candidate.trimmed : undefined;
}

export function isValidWebSearchResultCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= WEB_SEARCH_RESULTS_MAX_COUNT
  );
}

export function parseWebSearchQuery(
  value: unknown,
  options?: {
    readonly maxRawCharacters?: number;
    readonly maxRawBytes?: number;
  },
): string | undefined {
  if (typeof value !== "string" || hasWebSearchControlCharacter(value)) return undefined;
  if (
    options?.maxRawCharacters !== undefined &&
    codePointLength(value) > options.maxRawCharacters
  ) {
    return undefined;
  }
  if (options?.maxRawBytes !== undefined && utf8ByteLength(value) > options.maxRawBytes) {
    return undefined;
  }
  const query = value.trim();
  if (!query || codePointLength(query) > WEB_SEARCH_QUERY_MAX_CHARACTERS) return undefined;
  return query;
}

export function parseWebSearchResultCount(
  value: unknown,
  defaultCount = WEB_SEARCH_RESULTS_DEFAULT_COUNT,
): number | undefined {
  const count = value ?? defaultCount;
  return isValidWebSearchResultCount(count) ? count : undefined;
}

export function parseWebSearchApiKey(value: unknown): string | undefined {
  if (typeof value !== "string" || hasWebSearchControlCharacter(value)) return undefined;
  const key = value.trim();
  if (
    !key ||
    codePointLength(key) > WEB_SEARCH_API_KEY_MAX_CHARACTERS ||
    utf8ByteLength(key) > WEB_SEARCH_API_KEY_MAX_UTF8_BYTES
  ) {
    return undefined;
  }
  return key;
}

export type WebSearchCoreErrorCategory =
  | "invalid_request"
  | "authentication"
  | "rate_limit"
  | "upstream"
  | "network"
  | "timeout"
  | "cancelled"
  | "policy"
  | "invalid_response";

export interface WebSearchCoreErrorContract<P extends string = string> {
  providerId: P;
  category: WebSearchCoreErrorCategory;
  fallbackEligible: boolean;
  message: string;
}

export function createWebSearchCoreError<P extends string>(
  providerId: P,
  providerLabel: string,
  category: WebSearchCoreErrorCategory,
): WebSearchCoreErrorContract<P> {
  const fallbackEligible =
    category === "rate_limit" ||
    category === "upstream" ||
    category === "network" ||
    category === "timeout" ||
    category === "invalid_response";
  const messages: Record<WebSearchCoreErrorCategory, string> = {
    invalid_request: `${providerLabel} rejected the search request.`,
    authentication: `${providerLabel} authentication failed.`,
    rate_limit: `${providerLabel} search is temporarily rate limited.`,
    upstream: `${providerLabel} search is temporarily unavailable.`,
    network: `${providerLabel} search could not reach the provider.`,
    timeout: `${providerLabel} search timed out.`,
    cancelled: `${providerLabel} search was cancelled.`,
    policy: `${providerLabel} search was blocked by the network policy.`,
    invalid_response: `${providerLabel} returned an invalid response.`,
  };
  return Object.freeze({
    providerId,
    category,
    fallbackEligible,
    message: messages[category],
  });
}

export function classifyWebSearchHttpStatus(
  status: unknown,
  quotaStatuses: readonly number[] = [],
): WebSearchCoreErrorCategory {
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599) {
    return "invalid_response";
  }
  if (status >= 300 && status < 400) return "policy";
  if (status === 401 || status === 403) return "authentication";
  if (status === 408) return "timeout";
  if (status === 429 || quotaStatuses.includes(status)) return "rate_limit";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "upstream";
  return "invalid_response";
}

export function classifyWebSearchTransportFailure(kind: unknown): WebSearchCoreErrorCategory {
  if (kind === "redirect") return "policy";
  if (kind === "network" || kind === "timeout" || kind === "cancelled") return kind;
  return "invalid_response";
}

export function mapWebSearchCoreHttpError<P extends string>(
  providerId: P,
  providerLabel: string,
  status: unknown,
): WebSearchCoreErrorContract<P> {
  return createWebSearchCoreError(providerId, providerLabel, classifyWebSearchHttpStatus(status));
}

export function mapWebSearchCoreTransportError<P extends string>(
  providerId: P,
  providerLabel: string,
  kind: unknown,
): WebSearchCoreErrorContract<P> {
  return createWebSearchCoreError(
    providerId,
    providerLabel,
    classifyWebSearchTransportFailure(kind),
  );
}

export function webSearchErrorKindFromCoreCategory(
  category: WebSearchCoreErrorCategory,
): WebSearchErrorKind {
  switch (category) {
    case "invalid_request":
      return "invalid-request";
    case "authentication":
      return "auth";
    case "rate_limit":
      return "quota";
    case "upstream":
      return "transient";
    case "network":
      return "network";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "policy":
      return "config";
    case "invalid_response":
      return "invalid-response";
  }
}

export function requireWebSearchCoreQuery<P extends string>(
  value: unknown,
  providerId: P,
  providerLabel: string,
): string {
  const query = parseWebSearchQuery(value);
  if (query === undefined) {
    throw new Error(createWebSearchCoreError(providerId, providerLabel, "invalid_request").message);
  }
  return query;
}

export function requireWebSearchCoreResultCount<P extends string>(
  value: number | undefined,
  providerId: P,
  providerLabel: string,
): number {
  const count = parseWebSearchResultCount(value);
  if (count === undefined) {
    throw new Error(createWebSearchCoreError(providerId, providerLabel, "invalid_request").message);
  }
  return count;
}

export function requireWebSearchCoreApiKey<P extends string>(
  value: unknown,
  providerId: P,
  providerLabel: string,
): string {
  const key = parseWebSearchApiKey(value);
  if (key === undefined) {
    throw new Error(createWebSearchCoreError(providerId, providerLabel, "authentication").message);
  }
  return key;
}

export function isRedirectTransportFailure(error: unknown): boolean {
  if (error instanceof Error) {
    return /redirect|maximum redirect/iu.test(error.message);
  }
  if (!isRecord(error) || typeof error.code !== "string") return false;
  return /redirect/iu.test(error.code);
}

function parseSseJsonCandidates(body: string, maxEvents: number): unknown[] | undefined {
  const candidates: unknown[] = [];
  let dataLines: string[] = [];
  let eventCount = 0;

  const flush = () => {
    if (dataLines.length === 0) return;
    eventCount += 1;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // A malformed event does not hide a later, valid JSON-RPC event.
    }
  };

  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.length === 0) {
      flush();
      if (eventCount > maxEvents) return undefined;
      continue;
    }
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  return eventCount > maxEvents ? undefined : candidates;
}

export function parseWebSearchMcpCandidates(
  body: string,
  contentType?: unknown,
  maxSseEvents = WEB_SEARCH_MCP_MAX_SSE_EVENTS,
): unknown[] | undefined {
  const mediaType = parseWebSearchMediaType(contentType);
  if (
    mediaType !== undefined &&
    mediaType !== "application/json" &&
    mediaType !== "text/event-stream"
  ) {
    return undefined;
  }
  if (mediaType === "text/event-stream" || /^\s*(?:data:|event:|:)/u.test(body)) {
    return parseSseJsonCandidates(body, maxSseEvents);
  }
  try {
    return [JSON.parse(body)];
  } catch {
    return undefined;
  }
}

export interface WebSearchFormattedResult {
  title: string;
  url: string;
  text: string;
}

export interface WebSearchFormattedResultOptions {
  readonly maximumResults: number;
  readonly maxTitle: number;
  readonly maxUrl: number;
  readonly maxText: number;
  readonly unit?: WebSearchLengthUnit;
  readonly allowExcerptHeader?: boolean;
}

const FORMATTED_TEXT_HEADER = /^(?:Text|Highlights):[ \t]*(.*?)(?:\n|$)/mu;
const FORMATTED_TEXT_OR_EXCERPT_HEADER = /^(?:Text|Highlights|Excerpt):[ \t]*(.*?)(?:\n|$)/mu;

export function parseWebSearchFormattedResults(
  content: string,
  options: WebSearchFormattedResultOptions,
): WebSearchFormattedResult[] | undefined {
  const unit = options.unit ?? "bytes";
  const headerPattern = options.allowExcerptHeader
    ? FORMATTED_TEXT_OR_EXCERPT_HEADER
    : FORMATTED_TEXT_HEADER;
  const normalized = content.replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/(?=^Title:\s*)/gmu);
  const results: WebSearchFormattedResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.*)$/mu)?.[1] ?? "";
    const rawUrl = block.match(/^URL:\s*(.*)$/mu)?.[1];
    const url = validateWebSearchResultUrl(rawUrl, options.maxUrl, unit);
    if (!url) continue;
    const contentHeader = headerPattern.exec(block);
    let resultText = "";
    if (contentHeader?.index !== undefined) {
      const contentStart = contentHeader.index + contentHeader[0].length;
      const remainder = block.slice(contentStart);
      const separator = remainder.search(/\n---[ \t]*(?:\n|$)/u);
      const trailingText = separator >= 0 ? remainder.slice(0, separator) : remainder;
      const inlineText = contentHeader[1] ?? "";
      resultText = inlineText.length > 0 ? `${inlineText}\n${trailingText}` : trailingText;
    }
    results.push({
      title: boundWebSearchText(title, options.maxTitle, unit) || `Source ${results.length + 1}`,
      url,
      text: boundWebSearchText(resultText, options.maxText, unit),
    });
    if (results.length >= options.maximumResults) break;
  }
  return results.length > 0 ? results : undefined;
}
