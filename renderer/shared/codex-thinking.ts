export const CODEX_THINKING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CodexThinkingLevel = (typeof CODEX_THINKING_LEVELS)[number];

export const DEFAULT_CODEX_THINKING_LEVEL: CodexThinkingLevel = "medium";

const CODEX_THINKING_LEVEL_SET = new Set<string>(CODEX_THINKING_LEVELS);
const MAX_THINKING_MODEL_PREFERENCES = 256;
const MAX_MODEL_ID_CHARS = 256;

export function isCodexThinkingLevel(
  value: unknown,
): value is CodexThinkingLevel {
  return typeof value === "string" && CODEX_THINKING_LEVEL_SET.has(value);
}

interface CodexThinkingModelCapabilities {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/**
 * Match Pi's native model contract while omitting aliases and provider-default
 * states. XHigh and Max are opt-in capabilities in Pi's model metadata.
 */
export function codexThinkingLevelsForModel(
  model: CodexThinkingModelCapabilities,
): CodexThinkingLevel[] {
  if (model.reasoning !== true) return [];
  return CODEX_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

export function normalizeCodexThinkingLevel(
  levels: readonly CodexThinkingLevel[],
  value: unknown,
): CodexThinkingLevel {
  if (isCodexThinkingLevel(value) && levels.includes(value)) return value;
  return levels.includes(DEFAULT_CODEX_THINKING_LEVEL)
    ? DEFAULT_CODEX_THINKING_LEVEL
    : (levels[0] ?? DEFAULT_CODEX_THINKING_LEVEL);
}

/** Parse the complete device-local preference map before it crosses into persistence. */
export function parseCodexThinkingPreferences(
  value: unknown,
): Record<string, CodexThinkingLevel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex thinking preferences.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_THINKING_MODEL_PREFERENCES) {
    throw new Error("Too many Codex thinking preferences.");
  }
  const parsed: Record<string, CodexThinkingLevel> = {};
  for (const [modelId, level] of entries) {
    if (
      !modelId ||
      modelId.length > MAX_MODEL_ID_CHARS ||
      !isCodexThinkingLevel(level)
    ) {
      throw new Error("Invalid Codex thinking preference.");
    }
    parsed[modelId] = level;
  }
  return parsed;
}

export function mergeCodexThinkingPreference(
  current: unknown,
  modelId: string,
  level: CodexThinkingLevel,
): Record<string, CodexThinkingLevel> {
  let preferences: Record<string, CodexThinkingLevel> = {};
  try {
    preferences = parseCodexThinkingPreferences(current);
  } catch {
    // A validated mutation repairs malformed manually edited state.
  }
  return parseCodexThinkingPreferences({ ...preferences, [modelId]: level });
}
