import type { AuthResult } from "@earendil-works/pi-ai";
import { writeDevLog } from "../../dev-log.js";
import { AssetImageValidationError, validateImageBytes } from "../asset-image-validation-core.js";
import type { CoordinatorRetrySafety } from "../scheduler-core.js";
import type { ValidatedImageGenerationRequest } from "../provider-contract.js";
import {
  buildGeminiInteractionsRequest,
  GEMINI_IMAGE_MODELS,
  GEMINI_INTERACTIONS_ENDPOINT,
  validateGeminiImageRequest,
} from "./gemini-interactions-core.js";

export const GEMINI_IMAGE_REQUEST_TIMEOUT_MS = 180_000;
export const GEMINI_IMAGE_MAX_REQUEST_BYTES = 96 * 1024 * 1024;
export const GEMINI_IMAGE_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
export const GEMINI_IMAGE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const GEMINI_IMAGE_MAX_RETRY_AFTER_MS = 5 * 60_000;

const MAX_RESPONSE_STEPS = 128;
const MAX_CONTENT_BLOCKS_PER_STEP = 32;
const MAX_INTERACTION_ID_LENGTH = 256;
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const API_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/u;
const INTERACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function logGemini(
  level: "info" | "warn",
  message: string,
  metadata: Readonly<Record<string, unknown>>,
): void {
  const method = level === "info" ? console.info : console.warn;
  method(`[create-images] ${message}`, metadata);
  writeDevLog(level, "create-images", [message, metadata]);
}

export type GeminiImageProviderErrorCode =
  | "authentication-required"
  | "permission-denied"
  | "rate-limited"
  | "provider-unavailable"
  | "request-rejected"
  | "refused"
  | "provider-failed"
  | "provider-cancelled"
  | "incomplete"
  | "invalid-request"
  | "response-too-large"
  | "response-malformed"
  | "response-mime-mismatch"
  | "redirect-rejected"
  | "offline"
  | "timeout"
  | "cancelled-before-send"
  | "cancelled-after-send"
  | "submission-ambiguous";

export interface GeminiImageUsageMetadata {
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalThoughtTokens?: number;
  totalTokens?: number;
}

export interface GeminiImageProviderOutput {
  images: readonly [
    {
      bytes: Uint8Array;
      metadata: {
        source: "gemini-interactions";
        providerId: "gemini";
        modelId: string;
        mimeType: "image/png" | "image/jpeg";
        width: number;
        height: number;
        byteLength: number;
        outputIndex: 0;
      };
    },
  ];
  metadata: {
    source: "gemini-interactions";
    providerId: "gemini";
    modelId: string;
    count: 1;
    totalByteLength: number;
    interactionId?: string;
    usage?: GeminiImageUsageMetadata;
  };
}

interface GeminiAttemptBase {
  providerErrorCode: GeminiImageProviderErrorCode;
}

export type GeminiImageProviderAttemptResult =
  | { kind: "success"; output: GeminiImageProviderOutput }
  | (GeminiAttemptBase & {
      kind: "failure";
      error: string;
      retrySafety: CoordinatorRetrySafety;
    })
  | (GeminiAttemptBase & {
      kind: "rate-limited";
      error: string;
      retrySafety: "never";
      retryAfterMs?: number;
    })
  | (GeminiAttemptBase & { kind: "cancelled"; error: string })
  | (GeminiAttemptBase & { kind: "ambiguous-submit"; error: string });

export interface GeminiImageProviderExecutionContext {
  runId: string;
  nodeId: string;
  signal: AbortSignal;
}

export interface GeminiImageProviderOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxOutputBytes?: number;
  now?: () => number;
}

function failure(
  providerErrorCode: GeminiImageProviderErrorCode,
  error: string,
  retrySafety: CoordinatorRetrySafety = "never",
): Extract<GeminiImageProviderAttemptResult, { kind: "failure" }> {
  return { kind: "failure", providerErrorCode, error, retrySafety };
}

function ambiguous(
  providerErrorCode: Extract<
    GeminiImageProviderErrorCode,
    "offline" | "timeout" | "cancelled-after-send" | "submission-ambiguous"
  >,
  error: string,
): GeminiImageProviderAttemptResult {
  return { kind: "ambiguous-submit", providerErrorCode, error };
}

function safeApiKey(auth: AuthResult | undefined): string | undefined {
  const key = auth?.auth.apiKey;
  if (typeof key !== "string" || !API_KEY_PATTERN.test(key)) return undefined;
  return key;
}

function timeoutValue(value: number | undefined): number {
  const timeoutMs = value ?? GEMINI_IMAGE_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new Error("Gemini image timeout must be between 1 ms and 10 minutes.");
  }
  return timeoutMs;
}

function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`${label} must be a positive integer within Aiden's hard limit.`);
  }
  return limit;
}

function createCombinedSignal(
  external: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(external.reason);
  external.addEventListener("abort", onExternalAbort, { once: true });
  if (external.aborted) onExternalAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Gemini image request timed out."));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external.removeEventListener("abort", onExternalAbort);
    },
  };
}

function contentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(header)) return Number.NaN;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<Uint8Array> {
  const declared = contentLength(response);
  if (
    declared !== undefined &&
    (!Number.isSafeInteger(declared) || declared < 1 || declared > maxResponseBytes)
  ) {
    throw new BoundedResponseError("too-large");
  }
  if (!response.body) throw new BoundedResponseError("malformed");
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("Request aborted.");
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) continue;
      total += next.value.byteLength;
      if (total > maxResponseBytes) {
        throw new BoundedResponseError("too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (total === 0 || (declared !== undefined && declared !== total)) {
    throw new BoundedResponseError("malformed");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class BoundedResponseError extends Error {
  constructor(readonly reason: "too-large" | "malformed") {
    super("The Gemini response did not satisfy Aiden's response bounds.");
    this.name = "BoundedResponseError";
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_TOKEN_COUNT
    ? (value as number)
    : undefined;
}

function parseUsage(value: unknown): GeminiImageUsageMetadata | undefined {
  if (value === undefined) return undefined;
  const record = plainRecord(value);
  if (!record) throw new Error("usage");
  const fieldMap = [
    ["total_input_tokens", "totalInputTokens"],
    ["total_output_tokens", "totalOutputTokens"],
    ["total_thought_tokens", "totalThoughtTokens"],
    ["total_tokens", "totalTokens"],
  ] as const;
  const parsed: GeminiImageUsageMetadata = {};
  for (const [wireName, resultName] of fieldMap) {
    if (record[wireName] === undefined) continue;
    const count = parseTokenCount(record[wireName]);
    if (count === undefined) throw new Error("usage");
    parsed[resultName] = count;
  }
  return Object.keys(parsed).length > 0 ? Object.freeze(parsed) : undefined;
}

function strictBase64(value: unknown, maxOutputBytes: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maxOutputBytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new Error("base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maxOutputBytes ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("base64");
  }
  // Do not expose a view onto Node's pooled Buffer backing store.
  return Uint8Array.from(bytes);
}

function safeInteractionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > MAX_INTERACTION_ID_LENGTH ||
    !INTERACTION_ID_PATTERN.test(value)
  ) {
    throw new Error("interaction-id");
  }
  return value;
}

function containsRefusalMarker(steps: readonly unknown[]): boolean {
  for (const stepValue of steps) {
    const step = plainRecord(stepValue);
    const error = plainRecord(step?.error);
    const marker = error?.status;
    if (
      typeof marker === "string" &&
      /^(?:SAFETY|BLOCKED|CONTENT_FILTERED|PERMISSION_DENIED)$/u.test(marker)
    ) {
      return true;
    }
  }
  return false;
}

type ParsedCompletedResponse =
  | { kind: "success"; output: GeminiImageProviderOutput }
  | {
      kind: "failure";
      code: GeminiImageProviderErrorCode;
      message: string;
      diagnostic: string;
    }
  | { kind: "ambiguous" };

function completedFailure(
  code: GeminiImageProviderErrorCode,
  message: string,
  diagnostic: string,
): Extract<ParsedCompletedResponse, { kind: "failure" }> {
  return { kind: "failure", code, message, diagnostic };
}

function safeResponseShape(value: unknown): Readonly<Record<string, unknown>> {
  const response = plainRecord(value);
  const steps = Array.isArray(response?.steps) ? response.steps : [];
  let modelOutputStepCount = 0;
  let imageBlockCount = 0;
  let finalImageMime: "image/png" | "image/jpeg" | "missing" | "unsupported" = "missing";
  for (const stepValue of steps.slice(0, MAX_RESPONSE_STEPS)) {
    const step = plainRecord(stepValue);
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    modelOutputStepCount += 1;
    for (const blockValue of step.content.slice(0, MAX_CONTENT_BLOCKS_PER_STEP)) {
      const block = plainRecord(blockValue);
      if (block?.type !== "image") continue;
      imageBlockCount += 1;
      finalImageMime =
        block.mime_type === "image/png" || block.mime_type === "image/jpeg"
          ? block.mime_type
          : block.mime_type === undefined
            ? "missing"
            : "unsupported";
    }
  }
  const status = response?.status;
  return Object.freeze({
    responseStatus:
      typeof status === "string" &&
      [
        "completed",
        "failed",
        "cancelled",
        "incomplete",
        "in_progress",
        "queued",
        "requires_action",
      ].includes(status)
        ? status
        : "invalid",
    stepCount: steps.length,
    modelOutputStepCount,
    imageBlockCount,
    finalImageMime,
  });
}

function parseCompletedResponse(
  value: unknown,
  request: ValidatedImageGenerationRequest,
  maxOutputBytes: number,
): ParsedCompletedResponse {
  const response = plainRecord(value);
  if (!response) {
    return completedFailure(
      "response-malformed",
      "Gemini returned an invalid response.",
      "invalid-response-root",
    );
  }
  const steps = response.steps;
  if (!Array.isArray(steps) || steps.length > MAX_RESPONSE_STEPS) {
    return completedFailure(
      "response-malformed",
      "Gemini returned an invalid response timeline.",
      "invalid-response-timeline",
    );
  }
  const status = response.status;
  if (typeof status !== "string") {
    return completedFailure(
      "response-malformed",
      "Gemini returned an invalid response status.",
      "invalid-response-status",
    );
  }
  if (["in_progress", "queued", "requires_action"].includes(status)) {
    return { kind: "ambiguous" };
  }
  if (status !== "completed") {
    if (containsRefusalMarker(steps)) {
      return completedFailure(
        "refused",
        "Gemini declined this image request under its content policy.",
        "provider-refusal",
      );
    }
    const statusError: Record<string, [GeminiImageProviderErrorCode, string]> = {
      failed: ["provider-failed", "Gemini could not complete this image request."],
      cancelled: ["provider-cancelled", "Gemini cancelled this image request."],
      incomplete: ["incomplete", "Gemini returned an incomplete image response."],
    };
    const normalized = statusError[status];
    return normalized
      ? completedFailure(normalized[0], normalized[1], `provider-status-${status}`)
      : completedFailure(
          "response-malformed",
          "Gemini returned an unsupported response status.",
          "unsupported-response-status",
        );
  }

  let finalImage: { data: unknown; mimeType: unknown; remote: boolean } | undefined;
  for (const stepValue of steps) {
    const step = plainRecord(stepValue);
    if (!step || typeof step.type !== "string") {
      return completedFailure(
        "response-malformed",
        "Gemini returned an invalid response step.",
        "invalid-response-step",
      );
    }
    if (step.type !== "model_output") continue;
    if (!Array.isArray(step.content) || step.content.length > MAX_CONTENT_BLOCKS_PER_STEP) {
      return completedFailure(
        "response-malformed",
        "Gemini returned invalid model output.",
        "invalid-model-output",
      );
    }
    for (const blockValue of step.content) {
      const block = plainRecord(blockValue);
      if (!block || typeof block.type !== "string") {
        return completedFailure(
          "response-malformed",
          "Gemini returned an invalid output block.",
          "invalid-output-block",
        );
      }
      if (block.type === "image") {
        // Google's `interaction.output_image` convenience property selects the
        // last generated image block. Gemini 3 may expose earlier thought
        // images in the timeline, so mirror that exact final-output behavior.
        finalImage = {
          data: block.data,
          mimeType: block.mime_type,
          remote: block.uri !== undefined,
        };
      }
    }
  }
  if (!finalImage) {
    return containsRefusalMarker(steps)
      ? completedFailure(
          "refused",
          "Gemini declined this image request under its content policy.",
          "provider-refusal",
        )
      : completedFailure(
          "response-malformed",
          "Gemini returned no final image.",
          "missing-final-image",
        );
  }
  if (finalImage.remote) {
    return completedFailure(
      "response-malformed",
      "Gemini returned a remote image instead of bounded inline bytes.",
      "remote-final-image",
    );
  }
  if (
    finalImage.mimeType !== undefined &&
    finalImage.mimeType !== "image/png" &&
    finalImage.mimeType !== "image/jpeg"
  ) {
    return completedFailure(
      "response-mime-mismatch",
      "Gemini returned an unsupported image media type.",
      "unsupported-final-image-mime",
    );
  }
  try {
    const bytes = strictBase64(finalImage.data, maxOutputBytes);
    const descriptor = validateImageBytes(bytes, finalImage.mimeType, undefined, {
      maxWidth: 32_768,
      maxHeight: 32_768,
      maxPixels: 16_000_000,
    });
    const interactionId = safeInteractionId(response.id);
    const usage = parseUsage(response.usage);
    const metadata = Object.freeze({
      source: "gemini-interactions" as const,
      providerId: "gemini" as const,
      modelId: request.modelId,
      mimeType: descriptor.mediaType,
      width: descriptor.width,
      height: descriptor.height,
      byteLength: bytes.byteLength,
      outputIndex: 0 as const,
    });
    const output: GeminiImageProviderOutput = Object.freeze({
      images: Object.freeze([{ bytes, metadata }]) as GeminiImageProviderOutput["images"],
      metadata: Object.freeze({
        source: "gemini-interactions" as const,
        providerId: "gemini" as const,
        modelId: request.modelId,
        count: 1 as const,
        totalByteLength: bytes.byteLength,
        ...(interactionId ? { interactionId } : {}),
        ...(usage ? { usage } : {}),
      }),
    });
    return { kind: "success", output };
  } catch (error) {
    const code =
      error instanceof AssetImageValidationError && error.code === "mime_mismatch"
        ? "response-mime-mismatch"
        : "response-malformed";
    const diagnostic =
      error instanceof AssetImageValidationError
        ? error.code === "mime_mismatch"
          ? "declared-mime-does-not-match-bytes"
          : `invalid-image-${error.code}`
        : error instanceof Error && ["base64", "interaction-id", "usage"].includes(error.message)
          ? `invalid-${error.message}`
          : "invalid-image-data";
    return completedFailure(
      code,
      code === "response-mime-mismatch"
        ? "Gemini returned bytes that do not match the declared media type."
        : "Gemini returned invalid image data.",
      diagnostic,
    );
  }
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null || value.length > 128) return undefined;
  let delay: number;
  if (/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    delay = Number(value) * 1_000;
  } else {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    delay = Math.max(0, timestamp - now);
  }
  if (!Number.isSafeInteger(delay) || delay < 0) return undefined;
  return Math.min(delay, GEMINI_IMAGE_MAX_RETRY_AFTER_MS);
}

function statusResult(
  response: Response,
  now: number,
  metadata: SafeProviderFailureMetadata = {},
): Extract<GeminiImageProviderAttemptResult, { kind: "failure" | "rate-limited" }> | undefined {
  if (response.status >= 200 && response.status < 300) return undefined;
  if (
    response.status === 401 ||
    metadata.providerStatus === "UNAUTHENTICATED" ||
    metadata.providerReason === "API_KEY_INVALID"
  ) {
    return failure("authentication-required", "Gemini rejected the configured API key.");
  }
  if (response.status === 403 || metadata.providerStatus === "PERMISSION_DENIED") {
    return failure(
      "permission-denied",
      "The configured Gemini account cannot use this image model.",
    );
  }
  if (response.status === 429) {
    const delay = retryAfterMs(response.headers.get("retry-after"), now);
    return {
      kind: "rate-limited",
      providerErrorCode: "rate-limited",
      error: "Gemini is rate limiting image requests.",
      retrySafety: "never",
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    };
  }
  if (response.status >= 500 && response.status <= 599) {
    return failure("provider-unavailable", "Gemini is temporarily unavailable.");
  }
  if (response.status >= 300 && response.status <= 399) {
    return failure("redirect-rejected", "Gemini returned a redirect that Aiden will not follow.");
  }
  return failure("request-rejected", "Gemini rejected this image request.");
}

const SAFE_PROVIDER_MARKER = /^[A-Z][A-Z0-9_]{0,95}$/u;
const SAFE_PROVIDER_FIELD = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,127}$/u;

interface SafeProviderFailureMetadata {
  providerStatus?: string;
  providerReason?: string;
  providerFields?: readonly string[];
}

async function readSafeProviderFailureMetadata(
  response: Response,
  signal: AbortSignal,
): Promise<SafeProviderFailureMetadata> {
  try {
    const bytes = await readBoundedResponse(response, signal, MAX_PROVIDER_ERROR_BYTES);
    const root = plainRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const error = plainRecord(root?.error);
    const providerStatus =
      typeof error?.status === "string" && SAFE_PROVIDER_MARKER.test(error.status)
        ? error.status
        : undefined;
    const details = Array.isArray(error?.details) ? error.details : [];
    const providerReason = details
      .map((detail) => plainRecord(detail)?.reason)
      .find(
        (reason): reason is string =>
          typeof reason === "string" && SAFE_PROVIDER_MARKER.test(reason),
      );
    const providerFields = details
      .flatMap((detail) => {
        const fieldViolations = plainRecord(detail)?.fieldViolations;
        return Array.isArray(fieldViolations) ? fieldViolations : [];
      })
      .map((violation) => plainRecord(violation)?.field)
      .filter(
        (field): field is string => typeof field === "string" && SAFE_PROVIDER_FIELD.test(field),
      )
      .slice(0, 16);
    return {
      ...(providerStatus ? { providerStatus } : {}),
      ...(providerReason ? { providerReason } : {}),
      ...(providerFields.length > 0 ? { providerFields: Object.freeze(providerFields) } : {}),
    };
  } catch {
    response.body?.cancel().catch(() => undefined);
    return {};
  }
}

/**
 * Main-process-only stateless Gemini Interactions adapter. It accepts Pi's
 * resolved request auth, but deliberately uses only `auth.apiKey`; alternate
 * endpoints, inherited headers, OAuth bearer tokens, and provider URLs never
 * cross this fixed transport boundary.
 */
export class GeminiImageProvider {
  readonly providerId = "gemini" as const;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxOutputBytes: number;
  readonly #now: () => number;

  constructor(options: GeminiImageProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = timeoutValue(options.timeoutMs);
    this.#maxResponseBytes = boundedLimit(
      options.maxResponseBytes,
      GEMINI_IMAGE_MAX_RESPONSE_BYTES,
      "Gemini response byte limit",
    );
    this.#maxOutputBytes = boundedLimit(
      options.maxOutputBytes,
      GEMINI_IMAGE_MAX_OUTPUT_BYTES,
      "Gemini output byte limit",
    );
    this.#now = options.now ?? Date.now;
  }

  listModels() {
    return GEMINI_IMAGE_MODELS;
  }

  validate(request: ValidatedImageGenerationRequest): ValidatedImageGenerationRequest {
    return validateGeminiImageRequest(request);
  }

  async execute(
    auth: AuthResult | undefined,
    request: ValidatedImageGenerationRequest,
    context: GeminiImageProviderExecutionContext,
  ): Promise<GeminiImageProviderAttemptResult> {
    if (context.signal.aborted) {
      return {
        kind: "cancelled",
        providerErrorCode: "cancelled-before-send",
        error: "The Gemini image request was cancelled before it was sent.",
      };
    }
    const key = safeApiKey(auth);
    if (!key) {
      return failure(
        "authentication-required",
        "Connect a Google Gemini API key before creating remote images.",
        "confirmed-not-submitted",
      );
    }
    let validated: ValidatedImageGenerationRequest;
    let body: string;
    try {
      validated = this.validate(request);
      const serialized = buildGeminiInteractionsRequest(validated);
      body = JSON.stringify(serialized);
      if (Buffer.byteLength(body, "utf8") > GEMINI_IMAGE_MAX_REQUEST_BYTES) {
        return failure(
          "invalid-request",
          "The Gemini image request exceeds Aiden's request-size limit.",
          "confirmed-not-submitted",
        );
      }
    } catch {
      return failure(
        "invalid-request",
        "The Gemini image request is invalid.",
        "confirmed-not-submitted",
      );
    }
    if (context.signal.aborted) {
      return {
        kind: "cancelled",
        providerErrorCode: "cancelled-before-send",
        error: "The Gemini image request was cancelled before it was sent.",
      };
    }

    const requestStartedAt = this.#now();
    logGemini("info", "Sending Gemini image request.", {
      runId: context.runId,
      nodeId: context.nodeId,
      modelId: validated.modelId,
      referenceCount: validated.references.length,
      outputCount: validated.count,
      aspectRatio: validated.aspectRatio,
      imageSize: validated.imageSize,
      outputMime: validated.outputMime,
      requestBytes: Buffer.byteLength(body, "utf8"),
    });
    const combined = createCombinedSignal(context.signal, this.#timeoutMs);
    const done = <Result extends GeminiImageProviderAttemptResult>(result: Result): Result => {
      combined.dispose();
      return result;
    };
    let response: Response;
    try {
      response = await this.#fetch(GEMINI_INTERACTIONS_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key,
        },
        body,
        redirect: "error",
        signal: combined.signal,
      });
    } catch {
      if (combined.didTimeout()) {
        return done(
          ambiguous("timeout", "The Gemini request timed out after it may have been submitted."),
        );
      }
      if (context.signal.aborted) {
        return done(
          ambiguous(
            "cancelled-after-send",
            "The Gemini request was cancelled after submission; completion is unknown.",
          ),
        );
      }
      return done(
        ambiguous("offline", "A network error left the Gemini request's submission state unknown."),
      );
    }

    if (
      response.redirected ||
      (response.url !== "" && response.url !== GEMINI_INTERACTIONS_ENDPOINT)
    ) {
      response.body?.cancel().catch(() => undefined);
      return done(
        failure(
          "redirect-rejected",
          "Gemini returned a redirect or unexpected response origin that Aiden rejected.",
        ),
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      response.body?.cancel().catch(() => undefined);
      return done(failure("response-malformed", "Gemini returned an unexpected response type."));
    }
    const providerFailureMetadata =
      response.status >= 200 && response.status < 300
        ? {}
        : await readSafeProviderFailureMetadata(response, combined.signal);
    const normalizedStatus = statusResult(response, this.#now(), providerFailureMetadata);
    if (normalizedStatus) {
      logGemini("warn", "Gemini request ended with a safe provider failure.", {
        status: response.status,
        providerErrorCode: normalizedStatus.providerErrorCode,
        ...providerFailureMetadata,
      });
      return done(normalizedStatus);
    }
    if (response.status !== 200) {
      response.body?.cancel().catch(() => undefined);
      return done(failure("response-malformed", "Gemini returned an unsupported success status."));
    }

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponse(response, combined.signal, this.#maxResponseBytes);
    } catch (error) {
      if (combined.didTimeout()) {
        return done(ambiguous("timeout", "The Gemini response timed out after submission."));
      }
      if (context.signal.aborted) {
        return done(
          ambiguous(
            "cancelled-after-send",
            "The Gemini request was cancelled after submission; completion is unknown.",
          ),
        );
      }
      return done(
        failure(
          error instanceof BoundedResponseError && error.reason === "too-large"
            ? "response-too-large"
            : "response-malformed",
          error instanceof BoundedResponseError && error.reason === "too-large"
            ? "Gemini returned a response larger than Aiden's safe limit."
            : "Gemini returned a truncated or malformed response.",
        ),
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return done(failure("response-malformed", "Gemini returned invalid JSON."));
    }
    const parsed = parseCompletedResponse(decoded, validated, this.#maxOutputBytes);
    if (parsed.kind === "success") {
      logGemini("info", "Gemini image request completed.", {
        runId: context.runId,
        nodeId: context.nodeId,
        modelId: validated.modelId,
        durationMs: Math.max(0, this.#now() - requestStartedAt),
        outputCount: parsed.output.images.length,
        outputBytes: parsed.output.metadata.totalByteLength,
        outputMime: parsed.output.images[0].metadata.mimeType,
        width: parsed.output.images[0].metadata.width,
        height: parsed.output.images[0].metadata.height,
      });
      return done(parsed);
    }
    if (parsed.kind === "ambiguous") {
      return done(
        ambiguous(
          "submission-ambiguous",
          "Gemini accepted the request but did not return a terminal response.",
        ),
      );
    }
    logGemini("warn", "Gemini image response failed safe validation.", {
      runId: context.runId,
      nodeId: context.nodeId,
      modelId: validated.modelId,
      durationMs: Math.max(0, this.#now() - requestStartedAt),
      providerErrorCode: parsed.code,
      validationReason: parsed.diagnostic,
      ...safeResponseShape(decoded),
    });
    return done(failure(parsed.code, parsed.message));
  }
}
