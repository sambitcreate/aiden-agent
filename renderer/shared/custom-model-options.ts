import type { SamplingParamsByThinkingLevel } from "@earendil-works/pi-ai";

/** Explicit user overrides, separate from rediscovered provider metadata. */
export interface CustomModelOptions {
  samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
  vision?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  openWeights?: boolean;
  video?: boolean;
  contextLength?: number;
  outputLimit?: number;
  maxImages?: number;
}

export function parseCustomModelOptions(
  value: unknown,
): CustomModelOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid custom model options.");
  }
  const raw = value as Record<string, unknown>;
  const result: CustomModelOptions = {};
  if (raw.samplingParamsByThinkingLevel !== undefined) {
    result.samplingParamsByThinkingLevel = parseSamplingParamsByThinkingLevel(raw.samplingParamsByThinkingLevel);
  }
  for (const key of [
    "vision",
    "reasoning",
    "toolCall",
    "openWeights",
    "video",
  ] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean")
      throw new Error(`Invalid ${key} option.`);
    result[key] = raw[key];
  }
  for (const key of ["contextLength", "outputLimit", "maxImages"] as const) {
    if (raw[key] === undefined) continue;
    const number = raw[key];
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < (key === "maxImages" ? 0 : 1)
    ) {
      throw new Error(
        `Enter a whole ${key === "maxImages" ? "non-negative" : "positive"} number for ${key}.`,
      );
    }
    result[key] = number;
  }
  if (
    result.contextLength !== undefined &&
    result.outputLimit !== undefined &&
    result.outputLimit > result.contextLength
  ) {
    throw new Error("Maximum output tokens cannot exceed the context length.");
  }
  return result;
}

export function mergeDiscoveredModelMetadata<
  T extends { overrides?: CustomModelOptions; manuallyAdded?: boolean },
>(
  discovered: Record<string, T>,
  previous: Record<string, T>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(discovered).map(([id, metadata]) => [
      id,
      {
        ...metadata,
        ...(Object.prototype.hasOwnProperty.call(previous, id) &&
        previous[id].overrides
          ? { overrides: previous[id].overrides }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(previous, id) &&
        previous[id].manuallyAdded
          ? { manuallyAdded: true }
          : {}),
      },
    ]),
  );
}

/** Enforced in the shared generation path, including native-client requests. */
export function assertCustomModelImageLimit(
  options: CustomModelOptions | undefined,
  messages: ReadonlyArray<{
    role: string;
    attachments?: ReadonlyArray<{ kind: string }>;
  }>,
): void {
  if (options?.maxImages === undefined) return;
  if (
    messages.some(
      (message) =>
        message.role === "user" &&
        (message.attachments?.filter((item) => item.kind === "image").length ??
          0) > options.maxImages!,
    )
  ) {
    throw new Error(
      `This model supports at most ${options.maxImages} images per message. Remove images or choose another model.`,
    );
  }
}

/** Filter the final composed snapshot, including tools contributed by extensions. */
export function applyCustomModelToolPolicy<
  T extends { tools: readonly unknown[] },
>(snapshot: T, options: CustomModelOptions | undefined): T {
  return options?.toolCall === false ? { ...snapshot, tools: [] } : snapshot;
}

/** Deferred discovery must respect the same policy as the initial tool snapshot. */
export async function prepareCustomModelToolContext<T>(
  context: T,
  prepare: ((context: T) => Promise<T>) | undefined,
  options: CustomModelOptions | undefined,
): Promise<T> {
  return options?.toolCall === false || !prepare ? context : prepare(context);
}

/** Sampling only: metadata must not overwrite messages, tools, model or auth. */
export function parseSamplingParamsByThinkingLevel(value: unknown): SamplingParamsByThinkingLevel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid per-thinking-level sampling parameters.");
  const result: SamplingParamsByThinkingLevel = {};
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const fields = new Set(["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed"]);
  for (const [level, parameters] of Object.entries(value)) {
    if (!levels.has(level) || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Invalid sampling thinking level.");
    const parsed: Record<string, number> = {};
    for (const [key, number] of Object.entries(parameters)) {
      if (!fields.has(key) || typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 1_000_000) throw new Error("Invalid sampling parameter.");
      parsed[key] = number;
    }
    result[level as keyof SamplingParamsByThinkingLevel] = parsed;
  }
  return result;
}
