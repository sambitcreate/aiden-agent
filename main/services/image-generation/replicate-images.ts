// Replicate image generation as a Pi `ProviderImages` implementation for the
// Aiden-owned image API "replicate-images". Never rejects.

import type { ImageContent, ProviderImages } from "@earendil-works/pi-ai";
import {
  replicateReferenceMode,
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
  withPollRetries,
  type AdapterDeps,
  type Fetch,
  type RequestScope,
  requestedAspectRatio,
} from "./adapter-core.js";

export const REPLICATE_IMAGES_API = "replicate-images";
export const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const PROVIDER = "Replicate";
/** References at or under this many bytes go inline as data URIs. */
export const REPLICATE_INLINE_REFERENCE_BYTES = 256 * 1024;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/iu;
const PREDICTION_ID = /^[a-z0-9]{1,64}$/iu;
const VERSION_ID = /^[a-z0-9]{1,128}$/iu;
const TERMINAL = new Set(["succeeded", "failed", "canceled", "aborted"]);
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

async function latestVersion(modelPath: string, key: string, scope: RequestScope): Promise<string> {
  const response = await scope.fetch(modelPath, {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
    redirect: "error",
    signal: scope.signal,
  });
  if (!response.ok) throw await httpFailure(response, PROVIDER, scope.signal);
  const version = record(record(await readJson(response, PROVIDER, scope.signal))?.latest_version)?.id;
  if (typeof version !== "string" || !VERSION_ID.test(version)) {
    throw new ImageAdapterError("Replicate doesn't have a runnable version of this model.");
  }
  return version;
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
        const aspectRatio = requestedAspectRatio(options);
        if (aspectRatio && meta.aspectRatios?.includes(aspectRatio)) input.aspect_ratio = aspectRatio;
        if (references.length > 0) {
          const field = meta.referenceField;
          if (!field) throw new ImageAdapterError(NO_REFERENCES);
          const single = replicateReferenceMode(meta) === "single";
          const max = single ? 1 : Math.max(1, meta.maxReferences ?? 4);
          if (references.length > max) throw referenceLimitError(max);
          const values: string[] = [];
          for (const image of references) values.push(await referenceValue(image, key, scope));
          input[field] = single ? values[0] : values;
        }

        const [owner, name] = model.id.split("/") as [string, string];
        const activeKey = key;
        const activeScope = scope;
        const modelPath = `${REPLICATE_API_BASE}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
        const create = (url: string, body: Record<string, unknown>) =>
          activeScope.fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${activeKey}`,
              "content-type": "application/json",
              prefer: "wait=60",
            },
            body: JSON.stringify(body),
            redirect: "error",
            signal: activeScope.signal,
          });
        const createByVersion = (version: string) => create(`${REPLICATE_API_BASE}/predictions`, { version, input });

        let created: Response;
        if (meta.version && VERSION_ID.test(meta.version)) {
          created = await createByVersion(meta.version);
        } else {
          created = await create(`${modelPath}/predictions`, { input });
          // Only official models run by name; a community model needs its version.
          if (created.status === 404) {
            await created.body?.cancel().catch(() => undefined);
            const version = await latestVersion(modelPath, activeKey, activeScope);
            created = await createByVersion(version);
          }
        }
        if (!created.ok) throw await httpFailure(created, PROVIDER, scope.signal);
        let prediction = parsePrediction(await readJson(created, PROVIDER, scope.signal));
        predictionId = prediction.id;
        result.responseId = prediction.id;

        while (!TERMINAL.has(prediction.status)) {
          if (prediction.status !== "starting" && prediction.status !== "processing") {
            throw new ImageAdapterError("Replicate returned an unexpected status.");
          }
          await sleep(pollIntervalMs, scope.signal);
          const current = prediction;
          prediction = await withPollRetries(activeScope, pollIntervalMs, async () => {
            const polled = await activeScope.fetch(`${REPLICATE_API_BASE}/predictions/${current.id}`, {
              method: "GET",
              headers: { authorization: `Bearer ${activeKey}` },
              redirect: "error",
              signal: activeScope.signal,
            });
            if (!polled.ok) throw await httpFailure(polled, PROVIDER, activeScope.signal);
            const next = parsePrediction(await readJson(polled, PROVIDER, activeScope.signal));
            if (next.id !== current.id) throw new ImageAdapterError("Replicate returned an unexpected prediction.");
            return next;
          });
        }
        // A finished prediction has nothing left to cancel.
        predictionId = undefined;

        if (prediction.status === "failed") {
          const detail = providerDetail(prediction.error);
          throw new ImageAdapterError(
            detail ? `Replicate couldn't generate this image: ${detail}` : "Replicate couldn't generate this image.",
          );
        }
        if (prediction.status === "canceled" || prediction.status === "aborted") {
          throw new ImageAdapterError("Replicate cancelled this prediction.");
        }
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
        // A submitted, unfinished prediction keeps billing until cancelled.
        if (predictionId && key && scope) await cancelPrediction(scope.fetch, key, predictionId);
        return failureResult(result, error, PROVIDER, scope, key);
      }
    },
  };
}
