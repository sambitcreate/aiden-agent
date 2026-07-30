export const GOOGLE_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

export type GoogleThinkingLevel = (typeof GOOGLE_THINKING_LEVELS)[number];

export const DEFAULT_GOOGLE_THINKING_LEVEL: GoogleThinkingLevel = "off";

const GOOGLE_THINKING_LEVEL_SET = new Set<string>(GOOGLE_THINKING_LEVELS);
const MAX_THINKING_MODEL_PREFERENCES = 256;
const MAX_MODEL_ID_CHARS = 256;

export function isGoogleThinkingLevel(value: unknown): value is GoogleThinkingLevel {
  return typeof value === "string" && GOOGLE_THINKING_LEVEL_SET.has(value);
}

interface GoogleThinkingModelCapabilities {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/**
 * Keep the UI/request contract aligned with Pi's model-specific native levels.
 * "off" remains Aiden's no-exposed-thoughts state even when Google internally
 * requires the model's minimum hidden thinking level.
 */
export function googleThinkingLevelsForModel(
  model: GoogleThinkingModelCapabilities,
): GoogleThinkingLevel[] {
  if (model.reasoning !== true) return [];
  return GOOGLE_THINKING_LEVELS.filter(
    (level) => level === "off" || model.thinkingLevelMap?.[level] !== null,
  );
}

export function googleThinkingCanDisable(model: GoogleThinkingModelCapabilities): boolean {
  return model.reasoning === true && model.thinkingLevelMap?.off !== null;
}

export function normalizeGoogleThinkingLevel(
  levels: readonly GoogleThinkingLevel[],
  value: unknown,
): GoogleThinkingLevel {
  return isGoogleThinkingLevel(value) && levels.includes(value)
    ? value
    : (levels[0] ?? DEFAULT_GOOGLE_THINKING_LEVEL);
}

/** Parse the complete device-local preference map before it crosses into persistence. */
export function parseGoogleThinkingPreferences(
  value: unknown,
): Record<string, GoogleThinkingLevel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Google thinking preferences.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_THINKING_MODEL_PREFERENCES) {
    throw new Error("Too many Google thinking preferences.");
  }
  const parsed: Array<[string, GoogleThinkingLevel]> = [];
  for (const [modelId, level] of entries) {
    if (!modelId || modelId.length > MAX_MODEL_ID_CHARS || !isGoogleThinkingLevel(level)) {
      throw new Error("Invalid Google thinking preference.");
    }
    parsed.push([modelId, level]);
  }
  return Object.fromEntries(parsed);
}

export function mergeGoogleThinkingPreference(
  current: unknown,
  modelId: string,
  level: GoogleThinkingLevel,
): Record<string, GoogleThinkingLevel> {
  const entries =
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.entries(current).filter(
          ([id]) => Boolean(id) && id.length <= MAX_MODEL_ID_CHARS && id !== modelId,
        )
      : [];
  if (entries.length >= MAX_THINKING_MODEL_PREFERENCES) {
    throw new Error("Too many Google thinking preferences.");
  }
  return Object.fromEntries([...entries, [modelId, level]]) as Record<string, GoogleThinkingLevel>;
}
