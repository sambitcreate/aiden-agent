// Shared plumbing for Aiden's image-generation adapters (Replicate, fal):
// bounded reads, host-allowlisted downloads, redacted errors, and the
// never-reject result contract Pi expects from `ProviderImages`.

import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  ImagesOutputContent,
} from "@earendil-works/pi-ai";
import { readBoundedBody } from "../../shared/bounded-body.js";
import {
  MAX_GENERATED_IMAGE_BYTES,
  MAX_GENERATED_IMAGES,
  parseGeneratedImages,
} from "../pi-model-image-output.js";

export type Fetch = typeof fetch;

export const IMAGE_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const MAX_PROVIDER_JSON_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL = 300;

/** An error whose message is safe to show the user (never carries a key). */
export class ImageAdapterError extends Error {
  constructor(
    message: string,
    /** A retry of the same idempotent read may succeed (429, 5xx, garbled body). */
    readonly transient = false,
  ) {
    super(message);
    this.name = "ImageAdapterError";
  }
}

export interface AdapterDeps {
  fetch?: Fetch;
  /** Poll interval for queued work. Default 1500 ms. */
  pollIntervalMs?: number;
}

export interface RequestScope {
  signal: AbortSignal;
  /** The overall time limit in milliseconds. */
  limitMs: number;
  /** True when the caller aborted (as opposed to the overall time limit). */
  callerAborted(): boolean;
  fetch: Fetch;
}

export function requestScope(options: ImagesOptions | undefined, deps: AdapterDeps): RequestScope {
  const limit = Math.min(
    IMAGE_REQUEST_TIMEOUT_MS,
    typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : IMAGE_REQUEST_TIMEOUT_MS,
  );
  const timeout = AbortSignal.timeout(limit);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return {
    signal,
    limitMs: limit,
    callerAborted: () => options?.signal?.aborted === true,
    fetch: options?.fetch ?? deps.fetch ?? globalThis.fetch,
  };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function promptFromContext(context: ImagesContext): string {
  return context.input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

export function referencesFromContext(context: ImagesContext): ImageContent[] {
  return context.input.filter((item): item is ImageContent => item.type === "image");
}

export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

export function dataUri(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Recognize the four output formats Aiden accepts from their magic bytes. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

const DATA_URI = /^data:([a-z0-9.+/-]+)(?:;[a-z0-9=._-]+)*;base64,([A-Za-z0-9+/]+={0,2})$/iu;

export function imageFromDataUri(value: string, provider: string): ImageContent {
  if (value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 256) {
    throw new ImageAdapterError(`${provider} returned an image larger than 8 MiB.`);
  }
  const match = DATA_URI.exec(value);
  if (!match) throw new ImageAdapterError(`${provider} returned an image Aiden can't read.`);
  const data = match[2]!;
  const mimeType = sniffImageMime(Buffer.from(data.slice(0, 24), "base64")) ?? match[1]!.toLowerCase();
  return { type: "image", data, mimeType };
}

export async function readJson(
  response: Response,
  provider: string,
  signal: AbortSignal,
  maxBytes = MAX_PROVIDER_JSON_BYTES,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, {
    maxBytes,
    signal,
    errors: {
      tooLarge: () => new ImageAdapterError(`${provider} returned an oversized response.`),
      missingBody: () => new ImageAdapterError(`${provider} returned an empty response.`, true),
      invalidChunk: () => new ImageAdapterError(`${provider} returned an unreadable response.`, true),
    },
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ImageAdapterError(`${provider} returned an unreadable response.`, true);
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A short, single-line provider detail, safe to show. */
export function providerDetail(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") text = value;
  else {
    const body = record(value);
    const detail = body?.detail ?? body?.error ?? body?.message;
    if (typeof detail === "string") text = detail;
    else if (Array.isArray(detail)) {
      const first = record(detail[0]);
      if (typeof first?.msg === "string") text = first.msg;
    } else if (typeof record(detail)?.message === "string") {
      text = record(detail)!.message as string;
    }
  }
  if (!text) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean ? clean.slice(0, MAX_ERROR_DETAIL) : undefined;
}

/** Friendly status mapping; never includes request headers or keys. */
export async function httpFailure(response: Response, provider: string, signal: AbortSignal): Promise<ImageAdapterError> {
  let detail: string | undefined;
  try {
    detail = providerDetail(await readJson(response, provider, signal, 64 * 1024));
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  const status = response.status;
  if (status === 401 || status === 403) return new ImageAdapterError(`The ${provider} image key was rejected.`);
  if (status === 402) {
    return new ImageAdapterError(`${provider} needs billing set up or more credit on this account.`);
  }
  if (status === 429) return new ImageAdapterError(`${provider} is rate limiting requests. Try again shortly.`, true);
  if (status === 404) return new ImageAdapterError(`${provider} doesn't have this model.`);
  const suffix = detail ? `: ${detail}` : ".";
  if (status >= 400 && status < 500) return new ImageAdapterError(`${provider} rejected the request${suffix}`);
  return new ImageAdapterError(`${provider} had a problem (${status})${suffix}`, status >= 500);
}

/** Consecutive transient failures tolerated while polling one queued job. */
export const MAX_POLL_RETRIES = 6;
const MAX_POLL_BACKOFF_MS = 15_000;

/**
 * Run one idempotent poll read, retrying transient failures (429, 5xx,
 * network errors, unreadable bodies) with exponential backoff inside the
 * request's overall time budget.
 */
export async function withPollRetries<T>(
  scope: RequestScope,
  baseDelayMs: number,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let failures = 0; ; failures += 1) {
    try {
      return await attempt();
    } catch (error) {
      const transient = error instanceof ImageAdapterError ? error.transient : true;
      if (scope.signal.aborted || !transient || failures >= MAX_POLL_RETRIES) throw error;
      await sleep(Math.min(Math.max(1, baseDelayMs) * 2 ** failures, MAX_POLL_BACKOFF_MS), scope.signal);
    }
  }
}

/**
 * Download one generated image from an allowlisted HTTPS host, without
 * credentials and without following redirects.
 */
export async function downloadImage(
  rawUrl: string,
  options: { provider: string; allowHost(host: string): boolean; fetch: Fetch; signal: AbortSignal },
): Promise<ImageContent> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageAdapterError(`${options.provider} returned an invalid image address.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !options.allowHost(url.hostname.toLowerCase())) {
    throw new ImageAdapterError(`${options.provider} returned an image from an unexpected address.`);
  }
  const response = await options.fetch(url.href, {
    method: "GET",
    redirect: "error",
    signal: options.signal,
    headers: { accept: "image/*" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageAdapterError(`${options.provider} image download failed (${response.status}).`);
  }
  const bytes = await readBoundedBody(response, {
    maxBytes: MAX_GENERATED_IMAGE_BYTES,
    signal: options.signal,
    errors: {
      tooLarge: () => new ImageAdapterError(`${options.provider} returned an image larger than 8 MiB.`),
      missingBody: () => new ImageAdapterError(`${options.provider} returned an empty image.`),
    },
  });
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) {
    throw new ImageAdapterError(`${options.provider} returned an image format Aiden can't use.`);
  }
  return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType };
}

export function hostIs(domain: string): (host: string) => boolean {
  return (host) => host === domain || host.endsWith(`.${domain}`);
}

/** Collect at most MAX_GENERATED_IMAGES images from provider output entries. */
export async function collectImages(
  sources: readonly string[],
  load: (source: string) => Promise<ImageContent>,
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const source of sources.slice(0, MAX_GENERATED_IMAGES)) images.push(await load(source));
  return images;
}

export function emptyResult(model: ImageModel<ImageApi>): AssistantImages {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Validate decoded output with the shared image-output rules. */
export function validatedOutput(images: ImageContent[], provider: string): ImagesOutputContent[] {
  if (images.length === 0) throw new ImageAdapterError(`${provider} returned no images.`);
  try {
    return parseGeneratedImages(images, { overflow: "truncate" }).images;
  } catch (error) {
    throw new ImageAdapterError(error instanceof Error ? error.message : `${provider} returned unusable images.`);
  }
}

export function durationLabel(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** Turn any failure into the never-reject error shape. */
export function failureResult(
  result: AssistantImages,
  error: unknown,
  provider: string,
  scope: RequestScope | undefined,
  key?: string,
): AssistantImages {
  result.output = [];
  if (scope?.callerAborted()) {
    result.stopReason = "aborted";
    result.errorMessage = "Image generation was cancelled.";
    return result;
  }
  result.stopReason = "error";
  if (scope?.signal.aborted) {
    result.errorMessage = `${provider} took longer than ${durationLabel(scope.limitMs)}.`;
  } else if (error instanceof ImageAdapterError) {
    // Provider details are echoed only after the key is scrubbed from them.
    result.errorMessage = key && key.length >= 4 ? error.message.split(key).join("[redacted]") : error.message;
  } else {
    result.errorMessage = `Aiden couldn't reach ${provider}.`;
  }
  return result;
}

export function referenceLimitError(max: number): ImageAdapterError {
  return new ImageAdapterError(
    max === 1 ? "This model accepts one reference image." : `This model accepts at most ${max} reference images.`,
  );
}

export const NO_REFERENCES = "This model doesn't accept reference images.";
