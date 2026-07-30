export const ANTHROPIC_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

export type AnthropicThinkingLevel = (typeof ANTHROPIC_THINKING_LEVELS)[number];

export const DEFAULT_ANTHROPIC_THINKING_LEVEL: AnthropicThinkingLevel = "high";

const LEVEL_SET = new Set<string>(ANTHROPIC_THINKING_LEVELS);
const MAX_PREFERENCES = 256;
const MAX_MODEL_ID_CHARS = 256;

export function isAnthropicThinkingLevel(value: unknown): value is AnthropicThinkingLevel {
  return typeof value === "string" && LEVEL_SET.has(value);
}

interface AnthropicThinkingModelCapabilities {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** Expose Claude's distinct public effort choices, omitting Pi's internal minimal alias. */
export function anthropicThinkingLevelsForModel(
  model: AnthropicThinkingModelCapabilities,
): AnthropicThinkingLevel[] {
  if (model.reasoning !== true) return [];
  return ANTHROPIC_THINKING_LEVELS.filter((level) => {
    if (level === "off") return true;
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

export function anthropicThinkingCanDisable(model: AnthropicThinkingModelCapabilities): boolean {
  return model.reasoning === true && model.thinkingLevelMap?.off !== null;
}

export function normalizeAnthropicThinkingLevel(
  levels: readonly AnthropicThinkingLevel[],
  value: unknown,
): AnthropicThinkingLevel {
  if (isAnthropicThinkingLevel(value) && levels.includes(value)) return value;
  return levels.includes(DEFAULT_ANTHROPIC_THINKING_LEVEL)
    ? DEFAULT_ANTHROPIC_THINKING_LEVEL
    : (levels[0] ?? DEFAULT_ANTHROPIC_THINKING_LEVEL);
}

export function parseAnthropicThinkingPreferences(
  value: unknown,
): Record<string, AnthropicThinkingLevel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Anthropic thinking preferences.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PREFERENCES) {
    throw new Error("Too many Anthropic thinking preferences.");
  }
  const parsed: Array<[string, AnthropicThinkingLevel]> = [];
  for (const [modelId, level] of entries) {
    if (!modelId || modelId.length > MAX_MODEL_ID_CHARS || !isAnthropicThinkingLevel(level)) {
      throw new Error("Invalid Anthropic thinking preference.");
    }
    parsed.push([modelId, level]);
  }
  return Object.fromEntries(parsed);
}

export function mergeAnthropicThinkingPreference(
  current: unknown,
  modelId: string,
  level: AnthropicThinkingLevel,
): Record<string, AnthropicThinkingLevel> {
  const entries =
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.entries(current).filter(
          ([id]) => Boolean(id) && id.length <= MAX_MODEL_ID_CHARS && id !== modelId,
        )
      : [];
  if (entries.length >= MAX_PREFERENCES) {
    throw new Error("Too many Anthropic thinking preferences.");
  }
  return Object.fromEntries([...entries, [modelId, level]]) as Record<
    string,
    AnthropicThinkingLevel
  >;
}
