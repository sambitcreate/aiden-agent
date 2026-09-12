/** Explicit user overrides, separate from rediscovered provider metadata. */
export interface CustomModelOptions {
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
  messages: ReadonlyArray<{ attachments?: ReadonlyArray<{ kind: string }> }>,
): void {
  if (options?.maxImages === undefined) return;
  if (
    messages.some(
      (message) =>
        (message.attachments?.filter((item) => item.kind === "image").length ??
          0) > options.maxImages!,
    )
  ) {
    throw new Error(
      `This model supports at most ${options.maxImages} images per message. Remove images or choose another model.`,
    );
  }
}
