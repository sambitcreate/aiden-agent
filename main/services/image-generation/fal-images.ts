// fal queue image generation as a Pi `ProviderImages` implementation for the
// Aiden-owned image API "fal-images". Never rejects.

import type { ProviderImages } from "@earendil-works/pi-ai";
import { falAspectRatioInput } from "../../../renderer/shared/image-generation/aspect-ratio.js";
import type { ImageModelAdapter } from "../../../renderer/shared/image-generation/types.js";
import {
  base64ByteLength,
  collectImages,
  dataUri,
  downloadImage,
  emptyResult,
  failureResult,
  hostIs,
  httpFailure,
  imageFromDataUri,
  ImageAdapterError,
  NO_REFERENCES,
  promptFromContext,
  readJson,
  record,
  referenceLimitError,
  referencesFromContext,
  requestScope,
  sleep,
  validatedOutput,
  withPollRetries,
  type AdapterDeps,
  type Fetch,
  type RequestScope,
  requestedAspectRatio,
} from "./adapter-core.js";

export const FAL_IMAGES_API = "fal-images";
export const FAL_QUEUE_ORIGIN = "https://queue.fal.run";
const PROVIDER = "fal";
const ENDPOINT = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){1,5}$/iu;
const isFalMedia = hostIs("fal.media");
/** fal takes references inline as data URIs; their decoded total must stay within this. */
export const FAL_INLINE_REFERENCE_BYTES = 8 * 1024 * 1024;
export const FAL_REFERENCES_TOO_LARGE = "These reference images are too large for fal; use smaller images.";

type FalAdapter = Extract<ImageModelAdapter, { kind: "fal" }>;

export interface FalImagesDeps extends AdapterDeps {
  metadata(modelId: string): FalAdapter | undefined;
}

export function isFalEndpointId(value: string): boolean {
  return ENDPOINT.test(value) && !value.split("/").some((segment) => segment === "." || segment === "..");
}

function queueUrl(value: unknown): string {
  if (typeof value !== "string") throw new ImageAdapterError("fal returned an unexpected queue address.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ImageAdapterError("fal returned an unexpected queue address.");
  }
  if (url.origin !== FAL_QUEUE_ORIGIN || url.username || url.password) {
    throw new ImageAdapterError("fal returned an unexpected queue address.");
  }
  return url.href;
}

async function cancelRequest(fetchImpl: Fetch, key: string, url: string): Promise<void> {
  try {
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: { authorization: `Key ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort.
  }
}

function outputSources(value: unknown): string[] {
  const images = record(value)?.images;
  if (!Array.isArray(images)) throw new ImageAdapterError("fal returned output Aiden can't read.");
  return images.map((image) => {
    const url = record(image)?.url;
    if (typeof url !== "string") throw new ImageAdapterError("fal returned output Aiden can't read.");
    return url;
  });
}

export function falImagesApi(deps: FalImagesDeps): ProviderImages {
  const pollIntervalMs = deps.pollIntervalMs ?? 1500;
  return {
    async generateImages(model, context, options) {
      const result = emptyResult(model);
      let scope: RequestScope | undefined;
      let cancelUrl: string | undefined;
      let key: string | undefined;
      try {
        scope = requestScope(options, deps);
        key = options?.apiKey?.trim();
        if (!key) throw new ImageAdapterError("Add a fal key in Settings → Image Generation.");
        const meta = deps.metadata(model.id);
        if (!meta) throw new ImageAdapterError("This fal model isn't set up in Aiden.");
        const prompt = promptFromContext(context);
        if (!prompt) throw new ImageAdapterError("Describe the image to generate.");

        const references = referencesFromContext(context);
        const body: Record<string, unknown> = { prompt, num_images: 1, sync_mode: true };
        const shape = falAspectRatioInput(meta.aspectRatio, requestedAspectRatio(options));
        if (shape) body[shape.field] = shape.value;
        let endpoint = meta.textEndpoint;
        if (references.length > 0) {
          if (!meta.editEndpoint) throw new ImageAdapterError(NO_REFERENCES);
          const field = meta.referenceField ?? "image_urls";
          const max = field === "image_url" ? 1 : Math.max(1, meta.maxReferences ?? 4);
          if (references.length > max) throw referenceLimitError(max);
          const total = references.reduce((sum, image) => sum + base64ByteLength(image.data), 0);
          if (total > FAL_INLINE_REFERENCE_BYTES) throw new ImageAdapterError(FAL_REFERENCES_TOO_LARGE);
          endpoint = meta.editEndpoint;
          const values = references.map(dataUri);
          body[field] = field === "image_url" ? values[0] : values;
        }
        if (!isFalEndpointId(endpoint)) throw new ImageAdapterError("This fal model id isn't valid.");

        const auth = { authorization: `Key ${key}` };
        const submitted = await scope.fetch(`${FAL_QUEUE_ORIGIN}/${endpoint}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json", "x-fal-store-io": "0" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: scope.signal,
        });
        if (!submitted.ok) throw await httpFailure(submitted, PROVIDER, scope.signal);
        const queued = record(await readJson(submitted, PROVIDER, scope.signal));
        cancelUrl = queueUrl(queued?.cancel_url);
        const statusUrl = queueUrl(queued?.status_url);
        const responseUrl = queueUrl(queued?.response_url);
        if (typeof queued?.request_id === "string") result.responseId = queued.request_id.slice(0, 128);

        const activeScope = scope;
        for (;;) {
          const status = await withPollRetries(activeScope, pollIntervalMs, async () => {
            const polled = await activeScope.fetch(statusUrl, {
              method: "GET",
              headers: auth,
              redirect: "error",
              signal: activeScope.signal,
            });
            if (!polled.ok) throw await httpFailure(polled, PROVIDER, activeScope.signal);
            return record(await readJson(polled, PROVIDER, activeScope.signal))?.status;
          });
          if (status === "COMPLETED") break;
          if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
            throw new ImageAdapterError("fal returned an unexpected status.");
          }
          await sleep(pollIntervalMs, scope.signal);
        }
        cancelUrl = undefined;

        const finished = await withPollRetries(activeScope, pollIntervalMs, async () => {
          const response = await activeScope.fetch(responseUrl, {
            method: "GET",
            headers: auth,
            redirect: "error",
            signal: activeScope.signal,
          });
          if (!response.ok) throw await httpFailure(response, PROVIDER, activeScope.signal);
          return response;
        });
        // sync_mode returns images inline, so allow the 8 MiB output budget plus base64 overhead.
        const payload = await readJson(finished, PROVIDER, scope.signal, 12 * 1024 * 1024);

        const images = await collectImages(outputSources(payload), (source) =>
          source.startsWith("data:")
            ? Promise.resolve(imageFromDataUri(source, PROVIDER))
            : downloadImage(source, {
                provider: PROVIDER,
                allowHost: isFalMedia,
                fetch: activeScope.fetch,
                signal: activeScope.signal,
              }),
        );
        result.output = validatedOutput(images, PROVIDER);
        return result;
      } catch (error) {
        // A submitted, unfinished request keeps billing until cancelled.
        if (cancelUrl && key && scope) await cancelRequest(scope.fetch, key, cancelUrl);
        return failureResult(result, error, PROVIDER, scope, key);
      }
    },
  };
}
