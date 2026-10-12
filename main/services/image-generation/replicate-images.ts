// Replicate image generation as a Pi `ProviderImages` implementation for the
// Aiden-owned image API "replicate-images". Never rejects.

import type { ImageContent, ProviderImages } from "@earendil-works/pi-ai";
import {
  REPLICATE_REFERENCE_FIELDS,
  type ImageModelAdapter,
} from "../../../renderer/shared/image-generation/types.js";
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
  providerDetail,
  referenceLimitError,
  referencesFromContext,
  requestScope,
  sleep,
  validatedOutput,
  type AdapterDeps,
  type Fetch,
  type RequestScope,
} from "./adapter-core.js";

export const REPLICATE_IMAGES_API = "replicate-images";
export const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const PROVIDER = "Replicate";
/** References at or under this many bytes go inline as data URIs. */
export const REPLICATE_INLINE_REFERENCE_BYTES = 256 * 1024;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/iu;
const PREDICTION_ID = /^[a-z0-9]{1,64}$/iu;
const isReplicateDelivery = hostIs("replicate.delivery");

type ReplicateAdapter = Extract<ImageModelAdapter, { kind: "replicate" }>;

export interface ReplicateImagesDeps extends AdapterDeps {
  /** Curated, fetched or custom metadata for a model id. */
  metadata(modelId: string): ReplicateAdapter | undefined;
}

interface Prediction {
  id: string;
  status: string;
  output: unknown;
  error: unknown;
}

function parsePrediction(value: unknown): Prediction {
  const body = record(value);
  const id = body?.id;
  const status = body?.status;
  if (typeof id !== "string" || !PREDICTION_ID.test(id) || typeof status !== "string") {
    throw new ImageAdapterError("Replicate returned an unexpected prediction.");
  }
  return { id, status, output: body?.output, error: body?.error };
}

function outputSources(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output) && output.every((entry) => typeof entry === "string")) return output as string[];
  throw new ImageAdapterError("Replicate returned output Aiden can't read.");
}

async function uploadReference(
  image: ImageContent,
  key: string,
  scope: RequestScope,
): Promise<string> {
  const form = new FormData();
  const extension = image.mimeType.split("/")[1] ?? "bin";
  form.append(
    "content",
    new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }),
    `reference.${extension}`,
  );
  const response = await scope.fetch(`${REPLICATE_API_BASE}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    redirect: "error",
    signal: scope.signal,
  });
  if (!response.ok) throw await httpFailure(response, PROVIDER, scope.signal);
  const url = record(record(await readJson(response, PROVIDER, scope.signal))?.urls)?.get;
  if (typeof url !== "string") throw new ImageAdapterError("Replicate didn't accept the reference image.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageAdapterError("Replicate didn't accept the reference image.");
  }
  if (parsed.origin !== "https://api.replicate.com") {
    throw new ImageAdapterError("Replicate returned an unexpected file address.");
  }
  return parsed.href;
}

async function referenceValue(image: ImageContent, key: string, scope: RequestScope): Promise<string> {
  return base64ByteLength(image.data) <= REPLICATE_INLINE_REFERENCE_BYTES
    ? dataUri(image)
    : uploadReference(image, key, scope);
}

async function cancelPrediction(fetchImpl: Fetch, key: string, id: string): Promise<void> {
  try {
    const response = await fetchImpl(`${REPLICATE_API_BASE}/predictions/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort.
  }
}

export function replicateImagesApi(deps: ReplicateImagesDeps): ProviderImages {
  const pollIntervalMs = deps.pollIntervalMs ?? 1500;
  return {
    async generateImages(model, context, options) {
      const result = emptyResult(model);
      let scope: RequestScope | undefined;
      let predictionId: string | undefined;
      let key: string | undefined;
      try {
        scope = requestScope(options, deps);
        key = options?.apiKey?.trim();
        if (!key) throw new ImageAdapterError("Add a Replicate key in Settings → Image Generation.");
        if (!MODEL_ID.test(model.id)) throw new ImageAdapterError("This Replicate model id isn't valid.");
        const meta = deps.metadata(model.id) ?? { kind: "replicate" as const };
        const prompt = promptFromContext(context);
        if (!prompt) throw new ImageAdapterError("Describe the image to generate.");

        const references = referencesFromContext(context);
        const input: Record<string, unknown> = { ...(meta.input ?? {}), prompt };
        if (references.length > 0) {
          const field = meta.referenceField;
          if (!field) throw new ImageAdapterError(NO_REFERENCES);
          const single = REPLICATE_REFERENCE_FIELDS[field] === "single";
          const max = single ? 1 : Math.max(1, meta.maxReferences ?? 4);
          if (references.length > max) throw referenceLimitError(max);
          const values: string[] = [];
          for (const image of references) values.push(await referenceValue(image, key, scope));
          input[field] = single ? values[0] : values;
        }

        const [owner, name] = model.id.split("/") as [string, string];
        const created = await scope.fetch(
          `${REPLICATE_API_BASE}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/predictions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              prefer: "wait=60",
            },
            body: JSON.stringify({ input }),
            redirect: "error",
            signal: scope.signal,
          },
        );
        if (!created.ok) throw await httpFailure(created, PROVIDER, scope.signal);
        let prediction = parsePrediction(await readJson(created, PROVIDER, scope.signal));
        predictionId = prediction.id;
        result.responseId = prediction.id;

        while (prediction.status === "starting" || prediction.status === "processing") {
          await sleep(pollIntervalMs, scope.signal);
          const polled = await scope.fetch(`${REPLICATE_API_BASE}/predictions/${prediction.id}`, {
            method: "GET",
            headers: { authorization: `Bearer ${key}` },
            redirect: "error",
            signal: scope.signal,
          });
          if (!polled.ok) throw await httpFailure(polled, PROVIDER, scope.signal);
          const next = parsePrediction(await readJson(polled, PROVIDER, scope.signal));
          if (next.id !== prediction.id) throw new ImageAdapterError("Replicate returned an unexpected prediction.");
          prediction = next;
        }

        if (prediction.status === "failed") {
          const detail = providerDetail(prediction.error);
          throw new ImageAdapterError(
            detail ? `Replicate couldn't generate this image: ${detail}` : "Replicate couldn't generate this image.",
          );
        }
        if (prediction.status === "canceled") throw new ImageAdapterError("Replicate cancelled this prediction.");
        if (prediction.status !== "succeeded") throw new ImageAdapterError("Replicate returned an unexpected status.");
        predictionId = undefined;

        const activeScope = scope;
        const images = await collectImages(outputSources(prediction.output), (source) =>
          source.startsWith("data:")
            ? Promise.resolve(imageFromDataUri(source, PROVIDER))
            : downloadImage(source, {
                provider: PROVIDER,
                allowHost: isReplicateDelivery,
                fetch: activeScope.fetch,
                signal: activeScope.signal,
              }),
        );
        result.output = validatedOutput(images, PROVIDER);
        return result;
      } catch (error) {
        if (predictionId && key && scope?.signal.aborted) await cancelPrediction(scope.fetch, key, predictionId);
        return failureResult(result, error, PROVIDER, scope, key);
      }
    },
  };
}
