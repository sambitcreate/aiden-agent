function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trueKeys(value) {
  const input = record(value);
  if (!input) return undefined;
  const keys = Object.entries(input)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key)
    .sort();
  return keys.length > 0 ? keys : undefined;
}

function normalizeModel(value, index) {
  const model = record(value);
  const creator = record(model?.model_creator);
  const evaluations = record(model?.evaluations);
  const performance = record(model?.performance);
  const parameters = record(model?.parameters);
  const modalities = record(model?.modalities);
  const licensing = record(model?.licensing);
  const input = record(modalities?.input);
  const output = record(modalities?.output);

  const id = optionalString(model?.id);
  const slug = optionalString(model?.slug);
  const name = optionalString(model?.name);
  const creatorName = optionalString(creator?.name);
  if (!id || !slug || !name || !creatorName) {
    throw new Error(`Artificial Analysis model ${index} is missing id, slug, name, or creator.`);
  }

  return {
    id,
    slug,
    name,
    creator: creatorName,
    release_date: optionalString(model.release_date),
    reasoning: typeof model.reasoning_model === "boolean" ? model.reasoning_model : undefined,
    intelligence_index: finiteNumber(evaluations?.artificial_analysis_intelligence_index),
    coding_index: finiteNumber(evaluations?.artificial_analysis_coding_index),
    agentic_index: finiteNumber(evaluations?.artificial_analysis_agentic_index),
    median_output_tokens_per_second: positiveNumber(performance?.median_output_tokens_per_second),
    median_time_to_first_token_seconds: positiveNumber(
      performance?.median_time_to_first_token_seconds,
    ),
    median_end_to_end_response_time_seconds: positiveNumber(
      performance?.median_end_to_end_response_time_seconds,
    ),
    context_window_tokens: positiveNumber(model.context_window_tokens),
    parameter_count_billions: positiveNumber(parameters?.total),
    input_modalities: trueKeys(input),
    output_modalities: trueKeys(output),
    open_weights:
      typeof licensing?.is_open_weights === "boolean" ? licensing.is_open_weights : undefined,
    huggingface_url: optionalString(model.huggingface_url),
    openrouter_api_id: optionalString(model.openrouter_api_id),
  };
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** Map numeric values to 0...1 using average ranks for ties. */
export function percentileMap(models, select) {
  const rows = models
    .map((model) => ({ id: model.id, value: select(model) }))
    .filter((row) => typeof row.value === "number" && Number.isFinite(row.value))
    .sort((left, right) => left.value - right.value || left.id.localeCompare(right.id));
  const result = new Map();
  if (rows.length === 0) return result;
  if (rows.length === 1) {
    result.set(rows[0].id, 0.5);
    return result;
  }
  for (let start = 0; start < rows.length; ) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1].value === rows[start].value) end += 1;
    const averageRank = (start + end) / 2;
    const percentile = averageRank / (rows.length - 1);
    for (let index = start; index <= end; index += 1) result.set(rows[index].id, percentile);
    start = end + 1;
  }
  return result;
}

export function buildArtificialAnalysisSnapshot(
  pages,
  { fetchedAt, redistributionConfirmed, promptType = "long" },
) {
  if (!redistributionConfirmed) {
    throw new Error(
      "Redistribution confirmation is required before bundling Artificial Analysis data.",
    );
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("Artificial Analysis returned no pages.");
  }
  const first = record(pages[0]);
  const tier = first?.tier;
  const indexVersion = finiteNumber(first?.intelligence_index_version);
  if ((tier !== "pro" && tier !== "commercial") || indexVersion === undefined) {
    throw new Error("Artificial Analysis snapshot refresh requires a Pro or Commercial response.");
  }

  const models = [];
  const ids = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    const page = record(pages[index]);
    const pagination = record(page?.pagination);
    if (
      !page ||
      page.tier !== tier ||
      page.intelligence_index_version !== indexVersion ||
      pagination?.page !== index + 1 ||
      pagination.total_pages !== pages.length ||
      pagination.has_more !== index + 1 < pages.length ||
      !Array.isArray(page.data)
    ) {
      throw new Error(`Artificial Analysis page ${index + 1} has inconsistent metadata.`);
    }
    for (const rawModel of page.data) {
      const model = normalizeModel(rawModel, models.length);
      if (ids.has(model.id))
        throw new Error(`Artificial Analysis returned duplicate model ${model.id}.`);
      ids.add(model.id);
      models.push(model);
    }
  }

  const capability = percentileMap(models, (model) => model.intelligence_index);
  const responseTime = percentileMap(
    models,
    (model) => model.median_end_to_end_response_time_seconds,
  );
  const ranked = models
    .map((model) => {
      const capabilityPercentile = capability.get(model.id);
      const responseTimePercentile = responseTime.get(model.id);
      return omitUndefined({
        ...model,
        ranking:
          capabilityPercentile === undefined || responseTimePercentile === undefined
            ? undefined
            : {
                capability_percentile: capabilityPercentile,
                response_time_percentile: responseTimePercentile,
                pace_metric: "median_end_to_end_response_time_seconds",
              },
      });
    })
    .sort(
      (left, right) =>
        left.creator.localeCompare(right.creator) ||
        left.name.localeCompare(right.name) ||
        left.slug.localeCompare(right.slug) ||
        left.id.localeCompare(right.id),
    );

  return {
    schema_version: 1,
    source: {
      name: "Artificial Analysis",
      url: "https://artificialanalysis.ai/data-api",
      fetched_at: fetchedAt,
      tier,
      intelligence_index_version: indexVersion,
      prompt_type: promptType,
      redistribution_confirmed: true,
    },
    models: ranked,
  };
}

export function validateModelsDevSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("models.dev returned an unexpected payload.");
  }
  const providers = Object.values(value).map(record);
  const modelCount = providers.reduce(
    (count, provider) => count + Object.keys(record(provider?.models) ?? {}).length,
    0,
  );
  if (providers.length === 0 || modelCount === 0) {
    throw new Error("models.dev returned an empty catalog.");
  }
  return value;
}
