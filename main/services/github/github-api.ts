// Direct GitHub REST/GraphQL transport for the main process. Every answer is
// classified once into a small vocabulary so callers never parse status codes
// or GitHub error prose themselves.

import { normalizeGitHubHost } from "../../../renderer/shared/chat-pull-requests.js";
import type { GitHubCredential, GitHubCredentialResult } from "./github-credentials.js";

export const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 8;
const MAX_MESSAGE_CHARS = 600;

export type GitHubFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface GitHubCredentialProvider {
  resolve(host: string): Promise<GitHubCredentialResult>;
  invalidate(host: string, fingerprint?: string): void;
}

/** A GraphQL error tied to one field of an otherwise usable answer. */
export interface GitHubGraphQlFieldError {
  type?: string;
  message?: string;
  path?: Array<string | number>;
}

export type GitHubApiResult<T> =
  | { kind: "ok"; data: T; status: number; etag?: string; errors?: GitHubGraphQlFieldError[] }
  | { kind: "not-modified"; etag?: string }
  | {
      kind: "rate-limited";
      retryAt?: number;
      message: string;
      /** False when the request was refused locally without reaching GitHub. */
      sent: boolean;
    }
  | { kind: "unauthorized"; message: string }
  | { kind: "not-found"; message: string; data?: T; errors?: GitHubGraphQlFieldError[] }
  | { kind: "failed"; status?: number; message: string }
  | {
      kind: "unavailable";
      reason: "missing-tool" | "unauthenticated";
      message: string;
    };

export interface GitHubRequestContext {
  host: string;
  /** Stable label for usage accounting, e.g. `pr.summary.batch`. */
  operation: string;
  /** A user-initiated read; may spend the GraphQL reserve kept back from background reads. */
  interactive?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitHubRestRequest extends GitHubRequestContext {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path below the API root, e.g. `/repos/acme/app`. */
  path: string;
  body?: unknown;
  accept?: string;
  ifNoneMatch?: string;
}

export interface GitHubGraphQlRequest extends GitHubRequestContext {
  query: string;
  variables?: Record<string, unknown>;
}

export interface GitHubApiEndpoints {
  rest: string;
  graphql: string;
}

/** API roots: github.com, GHE.com data residency, and GHES. */
export function githubApiEndpoints(host: string): GitHubApiEndpoints {
  if (host === "github.com") {
    return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  }
  if (host.endsWith(".ghe.com")) {
    return { rest: `https://api.${host}`, graphql: `https://api.${host}/graphql` };
  }
  return { rest: `https://${host}/api/v3`, graphql: `https://${host}/api/graphql` };
}

export interface RateLimitHeaders {
  limit?: number;
  remaining?: number;
  /** Epoch ms of the window reset. */
  resetAt?: number;
  retryAfterMs?: number;
  resource?: string;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function readRateLimitHeaders(headers: Headers, now: number): RateLimitHeaders {
  const result: RateLimitHeaders = {};
  const limit = headerNumber(headers, "x-ratelimit-limit");
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const reset = headerNumber(headers, "x-ratelimit-reset");
  if (limit !== undefined) result.limit = limit;
  if (remaining !== undefined) result.remaining = remaining;
  if (reset !== undefined) result.resetAt = reset * 1_000;
  const resource = headers.get("x-ratelimit-resource");
  if (resource) result.resource = resource;
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      result.retryAfterMs = seconds * 1_000;
    } else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) result.retryAfterMs = Math.max(0, date - now);
    }
  }
  return result;
}

/** `retry-after` wins; otherwise the window reset, when GitHub sent one. */
export function retryAtFrom(headers: RateLimitHeaders, now: number): number | undefined {
  if (headers.retryAfterMs !== undefined) return now + headers.retryAfterMs;
  if (headers.resetAt !== undefined && headers.resetAt > now) return headers.resetAt;
  return undefined;
}

interface GraphQlError {
  type?: unknown;
  message?: unknown;
  path?: unknown;
}

function fieldError(error: GraphQlError): GitHubGraphQlFieldError {
  const type = typeof error.type === "string" ? error.type : undefined;
  const message = boundedMessage(error.message);
  const path = Array.isArray(error.path)
    ? error.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    : undefined;
  return { ...(type ? { type } : {}), ...(message ? { message } : {}), ...(path ? { path } : {}) };
}

const RATE_LIMIT_MESSAGE = /(?:secondary )?rate limit|abuse detection/iu;
const UNTYPED_QUOTA_MESSAGE = /rate limit (?:already )?exceeded/iu;

function boundedMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\p{Cc}+/gu, " ").trim();
  return text ? text.slice(0, MAX_MESSAGE_CHARS) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

class ResponseTooLargeError extends Error {}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(wake);
      });
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

/** What the transport tells an observer about each request it sends. */
export interface GitHubRequestObservation {
  scope: string;
  host: string;
  operation: string;
  kind: "rest" | "graphql";
  interactive: boolean;
  status?: number;
  outcome: GitHubApiResult<unknown>["kind"];
  retryAt?: number;
  headers?: RateLimitHeaders;
}

export type GitHubAdmission =
  | { ok: true; ticket?: unknown }
  | { ok: false; result: GitHubApiResult<never> };

export interface GitHubAdmissionRequest extends GitHubRequestContext {
  scope: string;
  kind: "rest" | "graphql";
  /** The caller's GraphQL document, before the gate amends it. */
  query?: string;
}

/**
 * Policy wrapped around every request: may amend read queries, refuse a
 * request before it is sent, and observes every outcome.
 */
export interface GitHubRequestGate {
  prepareQuery?(query: string): string;
  admit(request: GitHubAdmissionRequest): GitHubAdmission;
  settle(observation: GitHubRequestObservation, ticket: unknown, body: unknown): void;
  /** The caller aborted an admitted request before it was settled. */
  cancel?(ticket: unknown): void;
}

export interface GitHubApiOptions {
  credentials: GitHubCredentialProvider;
  gate?: GitHubRequestGate;
  fetch?: GitHubFetch;
  now?: () => number;
  concurrency?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  userAgent?: string;
}

interface SendOutcome {
  status: number;
  headers: Headers;
  text: string;
}

export class GitHubApi {
  private readonly credentials: GitHubCredentialProvider;
  private readonly now: () => number;
  private readonly fetchImpl: GitHubFetch;
  private readonly concurrency: Semaphore;
  private readonly gate: GitHubRequestGate | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;

  constructor(options: GitHubApiOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.concurrency = new Semaphore(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.gate = options.gate;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.userAgent = options.userAgent ?? "aiden-agent";
  }

  async rest<T>(request: GitHubRestRequest): Promise<GitHubApiResult<T>> {
    const host = this.requireHost(request.host);
    const path = request.path;
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || /(?:^|\/)\.\.(?:\/|$)/u.test(path)) {
      throw new Error("GitHub REST paths must be relative to the API root.");
    }
    const credential = await this.credential(host);
    if (!credential.ok) return credential.result;
    const headers: Record<string, string> = {
      Accept: request.accept ?? "application/vnd.github+json",
    };
    if (request.ifNoneMatch) headers["If-None-Match"] = request.ifNoneMatch;
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.exchange<T>(
      { ...request, host },
      credential.credential,
      "rest",
      `${githubApiEndpoints(host).rest}${path}`,
      request.method ?? "GET",
      headers,
      body,
      (outcome) => this.classifyRest<T>(outcome, request),
    );
  }

  async graphql<T>(request: GitHubGraphQlRequest): Promise<GitHubApiResult<T>> {
    const host = this.requireHost(request.host);
    const credential = await this.credential(host);
    if (!credential.ok) return credential.result;
    const body = JSON.stringify({
      query: this.gate?.prepareQuery ? this.gate.prepareQuery(request.query) : request.query,
      ...(request.variables ? { variables: request.variables } : {}),
    });
    return this.exchange<T>(
      { ...request, host },
      credential.credential,
      "graphql",
      githubApiEndpoints(host).graphql,
      "POST",
      { Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body,
      (outcome) => this.classifyGraphQl<T>(outcome),
    );
  }

  private requireHost(value: string): string {
    const host = normalizeGitHubHost(value);
    if (!host) throw new Error("The GitHub host is invalid.");
    return host;
  }

  private async credential(
    host: string,
  ): Promise<{ ok: true; credential: GitHubCredential } | { ok: false; result: GitHubApiResult<never> }> {
    const resolved = await this.credentials.resolve(host);
    if (resolved.ok) {
      // A credential is pinned to the host it was issued for.
      if (resolved.credential.host !== host) {
        return {
          ok: false,
          result: { kind: "unavailable", reason: "unauthenticated", message: "The GitHub credential belongs to another host." },
        };
      }
      return { ok: true, credential: resolved.credential };
    }
    return {
      ok: false,
      result: { kind: "unavailable", reason: resolved.missing.reason, message: resolved.missing.message },
    };
  }

  private async exchange<T>(
    request: GitHubRequestContext & { host: string; query?: string },
    credential: GitHubCredential,
    kind: "rest" | "graphql",
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    classify: (outcome: SendOutcome) => GitHubApiResult<T>,
  ): Promise<GitHubApiResult<T>> {
    if (request.signal?.aborted) throw abortError();
    const scope = credential.fingerprint;
    const interactive = request.interactive === true;
    const admission: GitHubAdmission = this.gate?.admit({ ...request, scope, kind }) ?? { ok: true };
    if (!admission.ok) return admission.result;
    const observe = (
      result: GitHubApiResult<T>,
      outcome?: SendOutcome,
      parsed?: unknown,
    ): GitHubApiResult<T> => {
      this.gate?.settle(
        {
          scope,
          host: request.host,
          operation: request.operation,
          kind,
          interactive,
          ...(outcome ? { status: outcome.status, headers: readRateLimitHeaders(outcome.headers, this.now()) } : {}),
          outcome: result.kind,
          ...(result.kind === "rate-limited" && result.retryAt !== undefined ? { retryAt: result.retryAt } : {}),
        },
        admission.ticket,
        parsed,
      );
      return result;
    };

    let release: (() => void) | undefined;
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
    try {
      release = await this.concurrency.acquire(signal);
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${credential.token}`,
          "User-Agent": this.userAgent,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        ...(body !== undefined ? { body } : {}),
        signal,
      });
      const text = await readBounded(response, this.maxResponseBytes);
      const outcome = { status: response.status, headers: response.headers, text };
      const result = classify(outcome);
      if (result.kind === "unauthorized") this.credentials.invalidate(request.host, credential.fingerprint);
      return observe(result, outcome, kind === "graphql" ? parseJson(text) : undefined);
    } catch (error) {
      if (request.signal?.aborted) {
        this.gate?.cancel?.(admission.ticket);
        throw abortError();
      }
      if (error instanceof ResponseTooLargeError) {
        return observe({ kind: "failed", message: "GitHub returned a response larger than Aiden accepts." });
      }
      if (timeout.signal.aborted) {
        return observe({
          kind: "failed",
          message: `GitHub did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`,
        });
      }
      return observe({ kind: "failed", message: "Aiden could not reach GitHub. Check the network connection." });
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }

  private classifyRest<T>(outcome: SendOutcome, request: GitHubRestRequest): GitHubApiResult<T> {
    const { status, headers, text } = outcome;
    const etag = headers.get("etag") ?? undefined;
    if (status === 304 && request.ifNoneMatch) return { kind: "not-modified", ...(etag ? { etag } : {}) };
    const parsed = parseJson(text);
    const message = isRecord(parsed) ? boundedMessage(parsed.message) : undefined;
    const rate = this.rateLimited<T>(status, headers, message ?? text);
    if (rate) return rate;
    if (status === 401) return { kind: "unauthorized", message: message ?? "GitHub rejected the saved credential." };
    if (status === 404) return { kind: "not-found", message: message ?? "GitHub could not find that resource." };
    if (status >= 200 && status < 300) {
      const data = (request.accept?.includes("diff") ? text : parsed) as T;
      return { kind: "ok", data, status, ...(etag ? { etag } : {}) };
    }
    return { kind: "failed", status, message: message ?? `GitHub answered with HTTP ${status}.` };
  }

  private classifyGraphQl<T>(outcome: SendOutcome): GitHubApiResult<T> {
    const { status, headers, text } = outcome;
    const parsed = parseJson(text);
    const errors: GraphQlError[] =
      isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors.filter(isRecord) : [];
    const firstMessage = errors.map((error) => boundedMessage(error.message)).find(Boolean)
      ?? (isRecord(parsed) ? boundedMessage(parsed.message) : undefined);
    const rate = this.rateLimited<T>(status, headers, firstMessage ?? text);
    if (rate) return rate;
    if (status === 401) return { kind: "unauthorized", message: firstMessage ?? "GitHub rejected the saved credential." };
    if (status < 200 || status >= 300) {
      return { kind: "failed", status, message: firstMessage ?? `GitHub answered with HTTP ${status}.` };
    }
    const data = (isRecord(parsed) ? parsed.data : undefined) as T | undefined;
    if (errors.length > 0) {
      const limitedHeaders = readRateLimitHeaders(headers, this.now());
      if (
        errors.some((error) => error.type === "RATE_LIMITED") ||
        limitedHeaders.remaining === 0 ||
        errors.some((error) => typeof error.message === "string" && UNTYPED_QUOTA_MESSAGE.test(error.message))
      ) {
        return this.rateLimitedResult(limitedHeaders, firstMessage);
      }
      const fieldErrors = errors.map(fieldError);
      if (errors.every((error) => error.type === "NOT_FOUND")) {
        return {
          kind: "not-found",
          message: firstMessage ?? "GitHub could not find that resource.",
          ...(data !== undefined && data !== null ? { data } : {}),
          errors: fieldErrors,
        };
      }
      // Errors scoped to a field leave the rest of the answer usable; a batched
      // document reports each alias's failure on its own.
      if (data !== undefined && data !== null && fieldErrors.every((error) => error.path && error.path.length > 0)) {
        return { kind: "ok", data, status, errors: fieldErrors };
      }
      return { kind: "failed", status, message: firstMessage ?? "GitHub returned a GraphQL error." };
    }
    if (data === undefined || data === null) {
      return { kind: "failed", status, message: "GitHub returned an empty GraphQL response." };
    }
    return { kind: "ok", data, status };
  }

  private rateLimited<T>(status: number, headers: Headers, body: string): GitHubApiResult<T> | undefined {
    const limits = readRateLimitHeaders(headers, this.now());
    const limited =
      status === 429 ||
      (status === 403 &&
        (limits.remaining === 0 || limits.retryAfterMs !== undefined || RATE_LIMIT_MESSAGE.test(body)));
    return limited ? this.rateLimitedResult(limits, boundedMessage(body)) : undefined;
  }

  private rateLimitedResult<T>(limits: RateLimitHeaders, message?: string): GitHubApiResult<T> {
    const retryAt = retryAtFrom(limits, this.now());
    return {
      kind: "rate-limited",
      ...(retryAt !== undefined ? { retryAt } : {}),
      message: message && RATE_LIMIT_MESSAGE.test(message) ? message : "GitHub's API rate limit was reached.",
      sent: true,
    };
  }
}
