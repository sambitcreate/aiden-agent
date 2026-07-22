import type { ModelRanking } from "./types.js";

export const MAX_ARTIFICIAL_ANALYSIS_MODELS = 10_000;

export interface ArtificialAnalysisSnapshotSource {
  name: "Artificial Analysis";
  url: string;
  fetched_at: string | null;
  tier: "pro" | "commercial" | null;
  intelligence_index_version: number | null;
  prompt_type: string;
  redistribution_confirmed: boolean;
}

export interface ArtificialAnalysisCatalog {
  schema_version: 1;
  source: {
    name: "Artificial Analysis";
    url: string;
    fetched_at: string | null;
    intelligence_index_version: number | null;
  };
  models: ArtificialAnalysisSnapshotModel[];
}

export interface ArtificialAnalysisSnapshotModel {
  id: string;
  slug: string;
  name: string;
  creator: string;
  release_date?: string;
  reasoning?: boolean;
  intelligence_index?: number;
  coding_index?: number;
  agentic_index?: number;
  median_output_tokens_per_second?: number;
  median_time_to_first_token_seconds?: number;
  median_end_to_end_response_time_seconds?: number;
  context_window_tokens?: number;
  parameter_count_billions?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  open_weights?: boolean;
  huggingface_url?: string;
  openrouter_api_id?: string;
  ranking?: {
    capability_percentile: number;
    response_time_percentile: number;
    pace_metric: "median_end_to_end_response_time_seconds";
  };
}

export interface ArtificialAnalysisSnapshot extends ArtificialAnalysisCatalog {
  source: ArtificialAnalysisSnapshotSource;
}

export type ArtificialAnalysisTier = "free" | "pro" | "commercial";

export interface ArtificialAnalysisUserCacheSource {
  name: "Artificial Analysis";
  url: "https://artificialanalysis.ai/data-api";
  endpoint: "https://artificialanalysis.ai/api/v2/language/models/free";
  generation: string;
  fetched_at: string;
  tier: ArtificialAnalysisTier;
  intelligence_index_version: number;
}

export interface ArtificialAnalysisUserCache extends ArtificialAnalysisCatalog {
  source: ArtificialAnalysisUserCacheSource;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Artificial Analysis snapshot field "${field}" must be a non-empty string.`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Artificial Analysis snapshot field "${field}" must be a boolean.`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string, positive = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new Error(
      `Artificial Analysis snapshot field "${field}" must be ${positive ? "a positive" : "a finite"} number.`,
    );
  }
  return value;
}

function optionalStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Artificial Analysis snapshot field "${field}" must be a string array.`);
  }
  return Array.from(new Set(value));
}

function percentile(value: unknown, field: string): number {
  const parsed = optionalNumber(value, field);
  if (parsed === undefined || parsed < 0 || parsed > 1) {
    throw new Error(`Artificial Analysis snapshot field "${field}" must be between 0 and 1.`);
  }
  return parsed;
}

function parseModel(value: unknown, index: number): ArtificialAnalysisSnapshotModel {
  const model = record(value);
  if (!model) throw new Error(`Artificial Analysis snapshot model ${index} must be an object.`);
  const id = optionalString(model.id, `models[${index}].id`);
  const slug = optionalString(model.slug, `models[${index}].slug`);
  const name = optionalString(model.name, `models[${index}].name`);
  const creator = optionalString(model.creator, `models[${index}].creator`);
  if (!id || !slug || !name || !creator) {
    throw new Error(`Artificial Analysis snapshot model ${index} is missing identity fields.`);
  }

  const rawRanking = record(model.ranking);
  const ranking = rawRanking
    ? {
        capability_percentile: percentile(
          rawRanking.capability_percentile,
          `models[${index}].ranking.capability_percentile`,
        ),
        response_time_percentile: percentile(
          rawRanking.response_time_percentile,
          `models[${index}].ranking.response_time_percentile`,
        ),
        pace_metric: "median_end_to_end_response_time_seconds" as const,
      }
    : undefined;
  if (rawRanking && rawRanking.pace_metric !== "median_end_to_end_response_time_seconds") {
    throw new Error(`Artificial Analysis snapshot model ${index} has an unsupported pace metric.`);
  }

  return {
    id,
    slug,
    name,
    creator,
    release_date: optionalString(model.release_date, `models[${index}].release_date`),
    reasoning: optionalBoolean(model.reasoning, `models[${index}].reasoning`),
    intelligence_index: optionalNumber(
      model.intelligence_index,
      `models[${index}].intelligence_index`,
    ),
    coding_index: optionalNumber(model.coding_index, `models[${index}].coding_index`),
    agentic_index: optionalNumber(model.agentic_index, `models[${index}].agentic_index`),
    median_output_tokens_per_second: optionalNumber(
      model.median_output_tokens_per_second,
      `models[${index}].median_output_tokens_per_second`,
      true,
    ),
    median_time_to_first_token_seconds: optionalNumber(
      model.median_time_to_first_token_seconds,
      `models[${index}].median_time_to_first_token_seconds`,
      true,
    ),
    median_end_to_end_response_time_seconds: optionalNumber(
      model.median_end_to_end_response_time_seconds,
      `models[${index}].median_end_to_end_response_time_seconds`,
      true,
    ),
    context_window_tokens: optionalNumber(
      model.context_window_tokens,
      `models[${index}].context_window_tokens`,
      true,
    ),
    parameter_count_billions: optionalNumber(
      model.parameter_count_billions,
      `models[${index}].parameter_count_billions`,
      true,
    ),
    input_modalities: optionalStrings(model.input_modalities, `models[${index}].input_modalities`),
    output_modalities: optionalStrings(
      model.output_modalities,
      `models[${index}].output_modalities`,
    ),
    open_weights: optionalBoolean(model.open_weights, `models[${index}].open_weights`),
    huggingface_url: optionalString(model.huggingface_url, `models[${index}].huggingface_url`),
    openrouter_api_id: optionalString(
      model.openrouter_api_id,
      `models[${index}].openrouter_api_id`,
    ),
    ranking,
  };
}

/** Validate the release snapshot and reject accidental unlicensed payloads. */
export function parseArtificialAnalysisSnapshot(value: unknown): ArtificialAnalysisSnapshot {
  const snapshot = record(value);
  if (!snapshot || snapshot.schema_version !== 1) {
    throw new Error("Bundled Artificial Analysis snapshot must use schema version 1.");
  }
  const rawSource = record(snapshot.source);
  if (!rawSource || rawSource.name !== "Artificial Analysis") {
    throw new Error("Bundled Artificial Analysis snapshot has an invalid source.");
  }
  if (!Array.isArray(snapshot.models)) {
    throw new Error("Bundled Artificial Analysis snapshot models must be an array.");
  }
  const redistributionConfirmed = rawSource.redistribution_confirmed;
  if (typeof redistributionConfirmed !== "boolean") {
    throw new Error("Artificial Analysis redistribution confirmation must be explicit.");
  }
  if (snapshot.models.length > 0 && !redistributionConfirmed) {
    throw new Error(
      "Artificial Analysis data cannot be bundled without redistribution confirmation.",
    );
  }
  const tier = rawSource.tier;
  if (tier !== null && tier !== "pro" && tier !== "commercial") {
    throw new Error("Artificial Analysis snapshot tier must be pro, commercial, or null.");
  }
  const fetchedAt = rawSource.fetched_at;
  if (
    fetchedAt !== null &&
    (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt)))
  ) {
    throw new Error("Artificial Analysis snapshot fetched_at must be an ISO timestamp or null.");
  }
  const indexVersion = rawSource.intelligence_index_version;
  if (
    indexVersion !== null &&
    (typeof indexVersion !== "number" || !Number.isFinite(indexVersion))
  ) {
    throw new Error("Artificial Analysis snapshot index version must be a number or null.");
  }
  if (typeof rawSource.url !== "string" || typeof rawSource.prompt_type !== "string") {
    throw new Error("Artificial Analysis snapshot source metadata is incomplete.");
  }
  if (
    snapshot.models.length > 0 &&
    (tier === null || fetchedAt === null || indexVersion === null)
  ) {
    throw new Error("Artificial Analysis data requires complete release provenance.");
  }

  return {
    schema_version: 1,
    source: {
      name: "Artificial Analysis",
      url: rawSource.url,
      fetched_at: fetchedAt,
      tier,
      intelligence_index_version: indexVersion,
      prompt_type: rawSource.prompt_type,
      redistribution_confirmed: redistributionConfirmed,
    },
    models: snapshot.models.map(parseModel),
  };
}

/** Validate the normalized device-local cache created from a user's own API request. */
export function parseArtificialAnalysisUserCache(value: unknown): ArtificialAnalysisUserCache {
  const cache = record(value);
  if (!cache || cache.schema_version !== 1) {
    throw new Error("Artificial Analysis user cache must use schema version 1.");
  }
  const rawSource = record(cache.source);
  if (!rawSource || rawSource.name !== "Artificial Analysis") {
    throw new Error("Artificial Analysis user cache has an invalid source.");
  }
  if (
    rawSource.url !== "https://artificialanalysis.ai/data-api" ||
    rawSource.endpoint !== "https://artificialanalysis.ai/api/v2/language/models/free"
  ) {
    throw new Error("Artificial Analysis user cache has an unexpected endpoint.");
  }
  if (
    typeof rawSource.generation !== "string" ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/iu.test(rawSource.generation)
  ) {
    throw new Error("Artificial Analysis user cache has an invalid generation.");
  }
  if (
    typeof rawSource.fetched_at !== "string" ||
    !Number.isFinite(Date.parse(rawSource.fetched_at))
  ) {
    throw new Error("Artificial Analysis user cache fetched_at must be an ISO timestamp.");
  }
  if (rawSource.tier !== "free" && rawSource.tier !== "pro" && rawSource.tier !== "commercial") {
    throw new Error("Artificial Analysis user cache has an invalid tier.");
  }
  if (
    typeof rawSource.intelligence_index_version !== "number" ||
    !Number.isFinite(rawSource.intelligence_index_version)
  ) {
    throw new Error("Artificial Analysis user cache has an invalid index version.");
  }
  if (
    !Array.isArray(cache.models) ||
    cache.models.length === 0 ||
    cache.models.length > MAX_ARTIFICIAL_ANALYSIS_MODELS
  ) {
    throw new Error("Artificial Analysis user cache must contain models.");
  }
  const models = cache.models.map(parseModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("Artificial Analysis user cache contains duplicate model identifiers.");
  }
  if (!models.some((model) => model.ranking)) {
    throw new Error("Artificial Analysis user cache contains no usable benchmark rankings.");
  }
  return {
    schema_version: 1,
    source: {
      name: "Artificial Analysis",
      url: "https://artificialanalysis.ai/data-api",
      endpoint: "https://artificialanalysis.ai/api/v2/language/models/free",
      generation: rawSource.generation,
      fetched_at: rawSource.fetched_at,
      tier: rawSource.tier,
      intelligence_index_version: rawSource.intelligence_index_version,
    },
    models,
  };
}

function identity(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/^https?:\/\/huggingface\.co\//u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function leafIdentity(value: string): string {
  const normalized = identity(value);
  const parts = value.split("/");
  const slashLeaf = parts[parts.length - 1] ?? value;
  return identity(slashLeaf) || normalized;
}

function modelAliases(model: ArtificialAnalysisSnapshotModel): Set<string> {
  const aliases = new Set<string>();
  for (const value of [model.slug, model.openrouter_api_id, model.huggingface_url, model.name]) {
    if (!value) continue;
    aliases.add(identity(value));
    aliases.add(leafIdentity(value));
  }
  return aliases;
}

function creatorMatches(model: ArtificialAnalysisSnapshotModel, creatorHint?: string): boolean {
  return !creatorHint || identity(model.creator) === identity(creatorHint);
}

/**
 * Exact aliases win. A canonical display-name fallback is accepted only when
 * the creator matches and exactly one snapshot row qualifies.
 */
export function findArtificialAnalysisModel(
  snapshot: ArtificialAnalysisCatalog,
  modelId: string,
  creatorHint?: string,
  canonicalName?: string,
): ArtificialAnalysisSnapshotModel | null {
  const identities = new Set([identity(modelId), leafIdentity(modelId)]);
  const exact = snapshot.models.filter(
    (model) =>
      creatorMatches(model, creatorHint) &&
      Array.from(identities).some((candidate) => modelAliases(model).has(candidate)),
  );
  if (exact.length === 1) return exact[0];

  if (!canonicalName) return null;
  const canonicalIdentity = identity(canonicalName);
  const byName = snapshot.models.filter(
    (model) => creatorMatches(model, creatorHint) && identity(model.name) === canonicalIdentity,
  );
  return byName.length === 1 ? byName[0] : null;
}

export function artificialAnalysisRanking(
  snapshot: ArtificialAnalysisCatalog,
  model: ArtificialAnalysisSnapshotModel,
): ModelRanking | undefined {
  if (!model.ranking) return undefined;
  const version = snapshot.source.intelligence_index_version;
  return {
    capabilityPercentile: model.ranking.capability_percentile,
    responseTimePercentile: model.ranking.response_time_percentile,
    source: version
      ? `Artificial Analysis · Intelligence Index v${version}`
      : "Artificial Analysis",
    sourceUrl: "https://artificialanalysis.ai",
    measuredAt: snapshot.source.fetched_at ?? undefined,
  };
}

export const EMPTY_ARTIFICIAL_ANALYSIS_SNAPSHOT: ArtificialAnalysisSnapshot = {
  schema_version: 1,
  source: {
    name: "Artificial Analysis",
    url: "https://artificialanalysis.ai/data-api",
    fetched_at: null,
    tier: null,
    intelligence_index_version: null,
    prompt_type: "long",
    redistribution_confirmed: false,
  },
  models: [],
};
