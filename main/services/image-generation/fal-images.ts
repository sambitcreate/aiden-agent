// fal queue image generation as a Pi `ProviderImages` implementation for the
// Aiden-owned image API "fal-images". Never rejects.

import type { ProviderImages } from "@earendil-works/pi-ai";
import type { ImageModelAdapter } from "../../../renderer/shared/image-generation/types.js";
import {
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
  type AdapterDeps,
  type Fetch,
  type RequestScope,
} from "./adapter-core.js";

export const FAL_IMAGES_API = "fal-images";
export const FAL_QUEUE_ORIGIN = "https://queue.fal.run";
const PROVIDER = "fal";
const ENDPOINT = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){1,5}$/iu;
const isFalMedia = hostIs("fal.media");

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
        let endpoint = meta.textEndpoint;
        if (references.length > 0) {
          if (!meta.editEndpoint) throw new ImageAdapterError(NO_REFERENCES);
          const field = meta.referenceField ?? "image_urls";
          const max = field === "image_url" ? 1 : Math.max(1, meta.maxReferences ?? 4);
          if (references.length > max) throw referenceLimitError(max);
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
        const statusUrl = queueUrl(queued?.status_url);
        const responseUrl = queueUrl(queued?.response_url);
        cancelUrl = queueUrl(queued?.cancel_url);
        if (typeof queued?.request_id === "string") result.responseId = queued.request_id.slice(0, 128);

        for (;;) {
          const polled = await scope.fetch(statusUrl, {
            method: "GET",
            headers: auth,
            redirect: "error",
            signal: scope.signal,
          });
          if (!polled.ok) throw await httpFailure(polled, PROVIDER, scope.signal);
          const status = record(await readJson(polled, PROVIDER, scope.signal))?.status;
          if (status === "COMPLETED") break;
          if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") {
            throw new ImageAdapterError("fal returned an unexpected status.");
          }
          await sleep(pollIntervalMs, scope.signal);
        }
        cancelUrl = undefined;

        const finished = await scope.fetch(responseUrl, {
          method: "GET",
          headers: auth,
          redirect: "error",
          signal: scope.signal,
        });
        if (!finished.ok) throw await httpFailure(finished, PROVIDER, scope.signal);
        // sync_mode returns images inline, so allow the 8 MiB output budget plus base64 overhead.
        const payload = await readJson(finished, PROVIDER, scope.signal, 12 * 1024 * 1024);

        const activeScope = scope;
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
        if (cancelUrl && key && scope?.signal.aborted) await cancelRequest(scope.fetch, key, cancelUrl);
        return failureResult(result, error, PROVIDER, scope, key);
      }
    },
  };
}
