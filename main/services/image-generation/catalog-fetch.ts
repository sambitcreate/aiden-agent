// User-initiated "Fetch latest models" for the three image providers. Fixed
// endpoints, no redirects, bounded bytes and pages, strict parsing. Nothing
// here runs on startup, in the background, or during onboarding.

import { readBoundedBody } from "../../shared/bounded-body.js";
import {
  inferImageModelMaker,
  openRouterImageModelDisplayName,
} from "../../../renderer/shared/image-generation/catalog.js";
import {
  IMAGE_GENERATION_LIMITS,
  MAX_IMAGE_REFERENCES,
  REPLICATE_REFERENCE_FIELDS,
  type ImageCatalogEntry,
  type ImageGenerationErrorCode,
  type ImageGenerationProviderId,
  type ReplicateReferenceField,
  type ReplicateReferenceMode,
} from "../../../renderer/shared/image-generation/types.js";
import {
  supportedImageAspectRatios,
  type ImageAspectRatio,
} from "../../../renderer/shared/image-generation/aspect-ratio.js";
import { isFalEndpointId } from "./fal-images.js";
import { REPLICATE_VERSION_ID } from "./settings-store.js";

type Fetch = typeof fetch;

export const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=image";
export const FAL_MODELS_URL = "https://api.fal.ai/v1/models";
export const REPLICATE_TEXT_TO_IMAGE_COLLECTION_URL = "https://api.replicate.com/v1/collections/text-to-image";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PAGES_PER_CATEGORY = 5;
const MAX_MODELS = IMAGE_GENERATION_LIMITS.maxFetchedModelsPerProvider;
const MAX_ID = IMAGE_GENERATION_LIMITS.maxModelIdLength;
const MAX_NAME = IMAGE_GENERATION_LIMITS.maxModelNameLength;
const SLASH_ID = /^[a-z0-9][a-z0-9._:-]*\/[a-z0-9][a-z0-9._:-]*$/iu;
const REPLICATE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/iu;
const FAL_CURSOR = /^[A-Za-z0-9+/=_-]{1,128}$/u;

export class CatalogFetchError extends Error {
  constructor(
    readonly code: Extract<ImageGenerationErrorCode, "network_error" | "rejected_key" | "invalid_catalog" | "key_required">,
    message: string,
  ) {
    super(message);
    this.name = "CatalogFetchError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return name && name.length <= MAX_NAME ? name : fallback;
}

function humanize(slug: string): string {
  return slug
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => (/^\d/u.test(word) ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ")
    .slice(0, MAX_NAME);
}

/** The whole user-pressed fetch (every page) must finish within this. */
export const IMAGE_CATALOG_FETCH_TIMEOUT_MS = 30_000;

function stopped(provider: string, signal: AbortSignal | undefined): CatalogFetchError {
  const reason: unknown = signal?.reason;
  const timedOut = reason instanceof Error && reason.name === "TimeoutError";
  return new CatalogFetchError(
    "network_error",
    timedOut ? `${provider} took too long to list its models. Try again.` : "Fetching models was cancelled.",
  );
}

function invalid(provider: string): CatalogFetchError {
  return new CatalogFetchError("invalid_catalog", `${provider} returned a model list Aiden can't read.`);
}

async function getJson(
  fetchImpl: Fetch,
  url: string,
  provider: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal,
    });
  } catch {
    if (signal?.aborted) throw stopped(provider, signal);
    throw new CatalogFetchError("network_error", `Aiden couldn't reach ${provider}.`);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogFetchError("rejected_key", `The ${provider} image key was rejected.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogFetchError("network_error", `${provider} couldn't list models (${response.status}).`);
  }
  const bytes = await readBoundedBody(response, {
    maxBytes: MAX_CATALOG_BYTES,
    signal,
    errors: {
      tooLarge: () => new CatalogFetchError("invalid_catalog", `${provider} returned an oversized model list.`),
      missingBody: () => invalid(provider),
      invalidChunk: () => invalid(provider),
      aborted: () => stopped(provider, signal),
    },
  }).catch((error: unknown) => {
    if (error instanceof CatalogFetchError) throw error;
    if (signal?.aborted) throw stopped(provider, signal);
    throw new CatalogFetchError("network_error", `Aiden couldn't reach ${provider}.`);
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalid(provider);
  }
}

// ---- OpenRouter ----

export function parseOpenRouterImageModels(value: unknown): ImageCatalogEntry[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw invalid("OpenRouter");
  const models: ImageCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (models.length >= MAX_MODELS) break;
    const entry = record(raw);
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > MAX_ID || !SLASH_ID.test(id) || seen.has(id)) continue;
    if (/^openrouter\/auto(?:[-/]|$)/u.test(id)) continue;
    const architecture = record(entry?.architecture);
    const output = stringArray(architecture?.output_modalities);
    if (!output.includes("image")) continue;
    const input = stringArray(architecture?.input_modalities);
    seen.add(id);
    const maker = inferImageModelMaker("openrouter", id);
    models.push({
      provider: "openrouter",
      id,
      name: openRouterImageModelDisplayName(cleanName(entry?.name, id)),
      ...(maker ? { maker } : {}),
      acceptsReferenceImages: input.includes("image"),
      adapter: { kind: "openrouter", textOutput: output.includes("text") },
    });
  }
  return models;
}

export async function fetchOpenRouterImageModels(fetchImpl: Fetch, signal?: AbortSignal): Promise<ImageCatalogEntry[]> {
  return parseOpenRouterImageModels(await getJson(fetchImpl, OPENROUTER_IMAGE_MODELS_URL, "OpenRouter", {}, signal));
}

// ---- fal ----

export interface FalModelSummary {
  endpoint: string;
  name: string;
  group?: string;
  groupLabel?: string;
}

/** Parse one page of `GET /v1/models`. */
export function parseFalModelsPage(value: unknown): { models: FalModelSummary[]; nextCursor?: string } {
  const body = record(value);
  const list = body?.models;
  if (!Array.isArray(list)) throw invalid("fal");
  const models: FalModelSummary[] = [];
  for (const raw of list) {
    const entry = record(raw);
    const endpoint = typeof entry?.endpoint_id === "string" ? entry.endpoint_id.trim() : "";
    if (!endpoint || endpoint.length > MAX_ID || !isFalEndpointId(endpoint)) continue;
    const metadata = record(entry?.metadata);
    if (metadata?.status !== undefined && metadata.status !== "active") continue;
    if (metadata?.kind !== undefined && metadata.kind !== "inference") continue;
    const group = record(metadata?.group);
    models.push({
      endpoint,
      name: cleanName(metadata?.display_name, endpoint),
      ...(typeof group?.key === "string" ? { group: group.key } : {}),
      ...(typeof group?.label === "string" ? { groupLabel: group.label } : {}),
    });
  }
  const cursor = body?.next_cursor;
  const nextCursor =
    body?.has_more === true && typeof cursor === "string" && FAL_CURSOR.test(cursor) ? cursor : undefined;
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

function editCandidates(endpoint: string): string[] {
  const segments = endpoint.split("/");
  const last = segments[segments.length - 1];
  const parent = segments.slice(0, -1).join("/");
  const candidates = [`${endpoint}/edit`];
  if (last === "text-to-image" || last === "generate") {
    candidates.push(`${parent}/edit`, `${parent}/edit-image`, `${parent}/image-to-image`);
  }
  return candidates;
}

/**
 * Pair text-to-image endpoints with their edit siblings: a known path
 * pattern first, then the same model group with an "Edit" label inside the
 * same namespace. Paired edit endpoints take `image_urls`.
 */
export function pairFalModels(
  textModels: readonly FalModelSummary[],
  editModels: readonly FalModelSummary[],
): ImageCatalogEntry[] {
  const editByEndpoint = new Map(editModels.map((model) => [model.endpoint, model]));
  const entries: ImageCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of textModels) {
    if (entries.length >= MAX_MODELS) break;
    if (seen.has(model.endpoint)) continue;
    seen.add(model.endpoint);
    let edit = editCandidates(model.endpoint).find((candidate) => editByEndpoint.has(candidate));
    if (!edit && model.group) {
      const namespace = model.endpoint.split("/", 1)[0];
      edit = editModels.find(
        (candidate) =>
          candidate.group === model.group &&
          /\bedit/iu.test(candidate.groupLabel ?? "") &&
          candidate.endpoint.split("/", 1)[0] === namespace,
      )?.endpoint;
    }
    const maker = inferImageModelMaker("fal", model.endpoint);
    entries.push({
      provider: "fal",
      id: model.endpoint,
      name: model.name,
      ...(maker ? { maker } : {}),
      acceptsReferenceImages: edit !== undefined,
      adapter: {
        kind: "fal",
        textEndpoint: model.endpoint,
        ...(edit ? { editEndpoint: edit, referenceField: "image_urls" as const, maxReferences: 4 } : {}),
      },
    });
  }
  return entries;
}

async function fetchFalCategory(
  fetchImpl: Fetch,
  category: "text-to-image" | "image-to-image",
  key: string | undefined,
  signal: AbortSignal | undefined,
): Promise<FalModelSummary[]> {
  const headers: Record<string, string> = key ? { authorization: `Key ${key}` } : {};
  const models: FalModelSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_CATEGORY; page += 1) {
    const url = new URL(FAL_MODELS_URL);
    url.searchParams.set("category", category);
    url.searchParams.set("status", "active");
    if (cursor) url.searchParams.set("cursor", cursor);
    const parsed = parseFalModelsPage(await getJson(fetchImpl, url.href, "fal", headers, signal));
    models.push(...parsed.models);
    if (!parsed.nextCursor || parsed.nextCursor === cursor || models.length >= MAX_MODELS) break;
    cursor = parsed.nextCursor;
  }
  return models;
}

export async function fetchFalImageModels(
  fetchImpl: Fetch,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<ImageCatalogEntry[]> {
  const textModels = await fetchFalCategory(fetchImpl, "text-to-image", key, signal);
  const editModels = await fetchFalCategory(fetchImpl, "image-to-image", key, signal);
  return pairFalModels(textModels, editModels);
}

// ---- Replicate ----

const REFERENCE_FIELD_PREFERENCE: readonly ReplicateReferenceField[] = [
  "image_input",
  "input_images",
  "images",
  "image",
  "input_image",
  "subject_reference",
];

/**
 * The schema node for an Input property with `$ref` and single-item
 * `allOf`/`anyOf`/`oneOf` wrappers followed, the way Cog writes them.
 */
function resolvedSchemaNode(
  value: unknown,
  schemas: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> | undefined {
  const node = record(value);
  if (!node || depth > 3) return undefined;
  if (typeof node.type === "string") return node;
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
    const name = ref.slice("#/components/schemas/".length);
    return Object.prototype.hasOwnProperty.call(schemas ?? {}, name)
      ? resolvedSchemaNode(schemas![name], schemas, depth + 1)
      : undefined;
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const found = resolvedSchemaNode(item, schemas, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Read the reference-image field from a Replicate OpenAPI Input schema. The
 * property's own type decides whether it takes a list or one image, so a
 * model whose `image` input is an array is sent an array.
 */
export function replicateReferenceField(
  schema: unknown,
): { field: ReplicateReferenceField; max: number; mode: ReplicateReferenceMode } | undefined {
  const schemas = record(record(record(schema)?.components)?.schemas);
  const properties = record(record(schemas?.Input)?.properties);
  if (!properties) return undefined;
  for (const field of REFERENCE_FIELD_PREFERENCE) {
    const property = resolvedSchemaNode(properties[field], schemas);
    if (!property) continue;
    if (property.type === "array") {
      const max = property.maxItems;
      return {
        field,
        mode: "array",
        max: typeof max === "number" && Number.isSafeInteger(max) && max >= 1 ? Math.min(max, MAX_IMAGE_REFERENCES) : 4,
      };
    }
    if (property.type === "string") return { field, mode: "single", max: 1 };
  }
  return undefined;
}

/**
 * The ratios a Replicate model accepts on its `aspect_ratio` input, read from
 * the OpenAPI Input schema: an inline `enum`, or Cog's usual
 * `allOf: [{ $ref: "#/components/schemas/aspect_ratio" }]`. Undefined when the
 * model has no such enum or it holds none of Aiden's ratios.
 */
export function replicateAspectRatios(schema: unknown): ImageAspectRatio[] | undefined {
  const schemas = record(record(record(schema)?.components)?.schemas);
  const property = record(record(schemas?.Input)?.properties)?.aspect_ratio;
  const enumOf = (value: unknown, depth: number): unknown[] | undefined => {
    const node = record(value);
    if (!node || depth > 3) return undefined;
    if (Array.isArray(node.enum)) return node.enum;
    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
      const name = ref.slice("#/components/schemas/".length);
      return Object.prototype.hasOwnProperty.call(schemas ?? {}, name) ? enumOf(schemas![name], depth + 1) : undefined;
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const found = enumOf(item, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  const values = enumOf(property, 0);
  if (!values) return undefined;
  const ratios = supportedImageAspectRatios(values);
  return ratios.length > 0 ? ratios : undefined;
}

export function parseReplicateCollection(value: unknown): ImageCatalogEntry[] {
  const list = record(value)?.models;
  if (!Array.isArray(list)) throw invalid("Replicate");
  const entries: ImageCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (entries.length >= MAX_MODELS) break;
    const model = record(raw);
    const owner = typeof model?.owner === "string" ? model.owner : "";
    const name = typeof model?.name === "string" ? model.name : "";
    if (!REPLICATE_SEGMENT.test(owner) || !REPLICATE_SEGMENT.test(name)) continue;
    const id = `${owner}/${name}`;
    if (id.length > MAX_ID || seen.has(id)) continue;
    const latest = record(model?.latest_version);
    const version = typeof latest?.id === "string" && REPLICATE_VERSION_ID.test(latest.id) ? latest.id : undefined;
    const reference = replicateReferenceField(latest?.openapi_schema);
    const aspectRatios = replicateAspectRatios(latest?.openapi_schema);
    seen.add(id);
    const maker = inferImageModelMaker("replicate", id);
    entries.push({
      provider: "replicate",
      id,
      name: humanize(name),
      ...(maker ? { maker } : {}),
      acceptsReferenceImages: reference !== undefined,
      adapter: {
        kind: "replicate",
        ...(reference
          ? {
              referenceField: reference.field,
              // Stored only when the schema disagrees with the field name's usual shape.
              ...(reference.mode !== REPLICATE_REFERENCE_FIELDS[reference.field] ? { referenceMode: reference.mode } : {}),
              maxReferences: reference.max,
            }
          : {}),
        // Community models only run by version, so keep the one the schema came from.
        ...(version ? { version } : {}),
        ...(aspectRatios ? { aspectRatios } : {}),
      },
    });
  }
  return entries;
}

export async function fetchReplicateImageModels(
  fetchImpl: Fetch,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<ImageCatalogEntry[]> {
  if (!key) throw new CatalogFetchError("key_required", "Add a Replicate key to fetch its model list.");
  return parseReplicateCollection(
    await getJson(fetchImpl, REPLICATE_TEXT_TO_IMAGE_COLLECTION_URL, "Replicate", { authorization: `Bearer ${key}` }, signal),
  );
}

export function fetchImageModels(
  provider: ImageGenerationProviderId,
  options: { fetch: Fetch; key: string | undefined; signal?: AbortSignal },
): Promise<ImageCatalogEntry[]> {
  if (provider === "openrouter") return fetchOpenRouterImageModels(options.fetch, options.signal);
  if (provider === "fal") return fetchFalImageModels(options.fetch, options.key, options.signal);
  return fetchReplicateImageModels(options.fetch, options.key, options.signal);
}
