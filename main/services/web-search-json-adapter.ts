/**
 * Bounded transport for the JSON-based Web Search providers.
 *
 * Provider modules own their fixed URL, request shape, and response parser.
 * This module owns the common network safety envelope: no redirects or
 * ambient credentials, no-store/no-referrer fetches, abort propagation,
 * declared and streamed response limits, and closed provider errors.
 */

import {
  normalizeWebSearchResultSet,
  webSearchError,
  WebSearchError,
  type WebSearchResultSet,
} from "./web-search-core.js";
import type {
  WebSearchAdapter,
  WebSearchAdapterRequest,
  WebSearchFetch,
} from "./web-search-provider-registry.js";
import type { WebSearchProviderId } from "./web-search-provider-registry-core.js";

export const WEB_SEARCH_JSON_RESPONSE_MAX_BYTES = 256 * 1_024;
export const WEB_SEARCH_JSON_REQUEST_MAX_BYTES = 8 * 1_024;
export const WEB_SEARCH_API_KEY_MAX_CHARS = 4_096;
export const WEB_SEARCH_API_KEY_MAX_BYTES = 8_192;

export interface WebSearchJsonRequestContract {
  readonly url: string;
  readonly init: {
    readonly method: "GET" | "POST";
    readonly redirect: "error";
    readonly credentials: "omit";
    readonly cache: "no-store";
    readonly referrerPolicy: "no-referrer";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  };
}

export interface WebSearchJsonRawResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly text?: unknown;
  readonly snippet?: unknown;
}

export interface WebSearchJsonParsedResponse {
  readonly results: readonly WebSearchJsonRawResult[];
}

export interface WebSearchJsonAdapterDefinition {
  readonly providerId: WebSearchProviderId;
  readonly endpoint: string;
  readonly allowQuery?: boolean;
  /** Provider-specific quota responses in addition to the common 429. */
  readonly quotaStatuses?: readonly number[];
  readonly buildRequest: (request: WebSearchAdapterRequest) => WebSearchJsonRequestContract;
  readonly parse: (
    payload: unknown,
    maximumResults: number,
  ) => WebSearchJsonParsedResponse | undefined;
}

export interface WebSearchJsonAdapterOptions {
  readonly fetch?: WebSearchFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

const CONTROL_CHARACTERS = /\p{Cc}/u;

function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/**
 * Validate the common model-facing query/count pair at each adapter boundary.
 * The service validates this first, but direct adapter callers must also fail
 * closed without allowing malformed values into a provider request.
 */
export function normalizeWebSearchJsonInput(
  providerId: WebSearchProviderId,
  queryValue: unknown,
  numResultsValue: unknown,
): { query: string; numResults: number } {
  if (
    typeof queryValue !== "string" ||
    !queryValue.trim() ||
    hasControlCharacter(queryValue) ||
    codePointLength(queryValue) > 2_000 ||
    utf8ByteLength(queryValue) > 8_192
  ) {
    throw webSearchError("invalid-request", providerId);
  }
  const query = queryValue.trim();
  const numResults = numResultsValue ?? 5;
  if (
    typeof numResults !== "number" ||
    !Number.isSafeInteger(numResults) ||
    numResults < 1 ||
    numResults > 10
  ) {
    throw webSearchError("invalid-request", providerId);
  }
  return { query, numResults };
}

/** Normalize and validate a provider API key without retaining it in errors. */
export function normalizeWebSearchApiKey(providerId: WebSearchProviderId, value: unknown): string {
  if (typeof value !== "string" || hasControlCharacter(value)) {
    throw webSearchError("auth", providerId);
  }
  const key = value.trim();
  if (
    key.length === 0 ||
    codePointLength(key) > WEB_SEARCH_API_KEY_MAX_CHARS ||
    utf8ByteLength(key) > WEB_SEARCH_API_KEY_MAX_BYTES
  ) {
    throw webSearchError("auth", providerId);
  }
  return key;
}

/** Require the API-key route; anonymous and provider-auth routes are not valid here. */
export function requireWebSearchApiKey(
  request: WebSearchAdapterRequest,
  providerId: WebSearchProviderId,
): string {
  if (request.credentialMode !== "api-key") throw webSearchError("auth", providerId);
  return normalizeWebSearchApiKey(providerId, request.credential);
}

function responseContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return undefined;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded; never expose an upstream
    // cancellation message through the provider error boundary.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // See cancelBody: cancellation failures are deliberately not observable.
  }
}

async function raceReader<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<T>>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("The request was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Read a response before parsing it. The declared content length and every
 * streamed chunk are checked so JSON.parse never sees an oversized payload.
 */
export async function readBoundedWebSearchJsonResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
  providerId: WebSearchProviderId,
): Promise<Uint8Array> {
  const declared = responseContentLength(response);
  if (declared !== undefined && declared > maximumBytes) {
    await cancelBody(response);
    throw webSearchError("invalid-response", providerId);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw webSearchError("invalid-response", providerId);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await raceReader(reader, signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw webSearchError("invalid-response", providerId);
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await cancelReader(reader);
        throw webSearchError("invalid-response", providerId);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeJsonBody(
  body: Uint8Array,
  providerId: WebSearchProviderId,
  contentType: string | undefined,
): unknown {
  const mediaType =
    typeof contentType === "string"
      ? contentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
  if (mediaType !== undefined && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw webSearchError("invalid-response", providerId);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw webSearchError("invalid-response", providerId);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw webSearchError("invalid-response", providerId);
  }
}

function statusError(
  providerId: WebSearchProviderId,
  status: unknown,
  quotaStatuses: readonly number[] = [],
): WebSearchError {
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599) {
    return webSearchError("invalid-response", providerId);
  }
  if (status >= 300 && status < 400) return webSearchError("config", providerId);
  if (status === 401 || status === 403) return webSearchError("auth", providerId);
  if (status === 408) return webSearchError("timeout", providerId);
  if (status === 429 || quotaStatuses.includes(status)) {
    return webSearchError("quota", providerId);
  }
  if (status >= 500) return webSearchError("transient", providerId);
  if (status >= 400) return webSearchError("invalid-request", providerId);
  return webSearchError("invalid-response", providerId);
}

function redirectFailure(error: unknown): boolean {
  if (error instanceof Error) return /redirect|maximum redirect/iu.test(error.message);
  if (!isRecord(error) || typeof error.code !== "string") return false;
  return /redirect/iu.test(error.code);
}

/** Map fetch failures without retaining an upstream message, URL, or body. */
export function mapWebSearchJsonTransportError(
  providerId: WebSearchProviderId,
  error: unknown,
  request: Pick<WebSearchAdapterRequest, "signal" | "timedOut">,
): WebSearchError {
  if (request.signal.aborted) {
    return webSearchError(request.timedOut?.() === true ? "timeout" : "cancelled", providerId);
  }
  if (redirectFailure(error)) return webSearchError("config", providerId);
  return webSearchError("network", providerId);
}

function rawResultsPayload(
  parsed: WebSearchJsonParsedResponse,
  providerId: WebSearchProviderId,
): WebSearchResultSet {
  try {
    return normalizeWebSearchResultSet(providerId, { results: parsed.results });
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    throw webSearchError("invalid-response", providerId);
  }
}

function requestWithSignal(
  contract: WebSearchJsonRequestContract,
  signal: AbortSignal,
): RequestInit {
  return {
    method: contract.init.method,
    headers: contract.init.headers,
    ...(contract.init.body === undefined ? {} : { body: contract.init.body }),
    redirect: contract.init.redirect,
    credentials: contract.init.credentials,
    cache: contract.init.cache,
    referrerPolicy: contract.init.referrerPolicy,
    signal,
  };
}

function fixedEndpointMatches(endpoint: string, requestUrl: string, allowQuery: boolean): boolean {
  try {
    const expected = new URL(endpoint);
    const actual = new URL(requestUrl);
    return (
      expected.protocol === "https:" &&
      !expected.username &&
      !expected.password &&
      !expected.search &&
      !expected.hash &&
      actual.protocol === expected.protocol &&
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      !actual.username &&
      !actual.password &&
      !actual.hash &&
      (allowQuery || actual.search === expected.search)
    );
  } catch {
    return false;
  }
}

/** Build a factory-compatible adapter with the shared JSON transport policy. */
export function createWebSearchJsonAdapter(
  definition: WebSearchJsonAdapterDefinition,
  options: WebSearchJsonAdapterOptions = {},
): WebSearchAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw webSearchError("unavailable", definition.providerId);

  return Object.freeze({
    providerId: definition.providerId,
    adapterVersion: 1,
    async search(request: WebSearchAdapterRequest): Promise<WebSearchResultSet> {
      let contract: WebSearchJsonRequestContract;
      try {
        contract = definition.buildRequest(request);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-request", definition.providerId);
      }
      if (
        !fixedEndpointMatches(definition.endpoint, contract.url, definition.allowQuery === true)
      ) {
        throw webSearchError("config", definition.providerId);
      }
      const body = contract.init.body;
      if (body !== undefined && utf8ByteLength(body) > WEB_SEARCH_JSON_REQUEST_MAX_BYTES) {
        throw webSearchError("invalid-request", definition.providerId);
      }

      let response: Response;
      try {
        response = await fetchImpl(contract.url, requestWithSignal(contract, request.signal));
      } catch (error) {
        throw mapWebSearchJsonTransportError(definition.providerId, error, request);
      }

      if (
        !response ||
        typeof response.status !== "number" ||
        !response.headers ||
        typeof response.headers.get !== "function"
      ) {
        throw webSearchError("invalid-response", definition.providerId);
      }
      if (response.status < 200 || response.status >= 300) {
        await cancelBody(response);
        throw statusError(definition.providerId, response.status, definition.quotaStatuses);
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedWebSearchJsonResponse(
          response,
          request.signal,
          WEB_SEARCH_JSON_RESPONSE_MAX_BYTES,
          definition.providerId,
        );
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw mapWebSearchJsonTransportError(definition.providerId, error, request);
      }
      if (request.signal.aborted) {
        throw webSearchError(
          request.timedOut?.() === true ? "timeout" : "cancelled",
          definition.providerId,
        );
      }

      let contentType: string | undefined;
      try {
        contentType = response.headers.get("content-type") ?? undefined;
      } catch {
        throw webSearchError("invalid-response", definition.providerId);
      }
      const payload = decodeJsonBody(bytes, definition.providerId, contentType);
      let parsed: WebSearchJsonParsedResponse | undefined;
      try {
        parsed = definition.parse(payload, request.numResults);
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        throw webSearchError("invalid-response", definition.providerId);
      }
      if (!parsed || !Array.isArray(parsed.results)) {
        throw webSearchError("invalid-response", definition.providerId);
      }
      if (request.signal.aborted) {
        throw webSearchError(
          request.timedOut?.() === true ? "timeout" : "cancelled",
          definition.providerId,
        );
      }
      return rawResultsPayload(parsed, definition.providerId);
    },
  });
}

/** Exported for provider parser tests without exposing response/body details. */
export function mapWebSearchJsonHttpError(
  providerId: WebSearchProviderId,
  status: unknown,
  quotaStatuses: readonly number[] = [],
): WebSearchError {
  return statusError(providerId, status, quotaStatuses);
}
