// The reasoning effort a chat turn asks for. Main clamps it to what the model
// supports (`resolveGenerationThinkingLevel` in llm-client.ts), so this only
// picks which preference applies.

import type { GenerationThinkingLevel } from "../shared/generation-thinking";

/** A model family's saved per-model level and whether the current model uses it. */
export interface SavedThinkingPreference {
  supported: boolean;
  level: GenerationThinkingLevel;
}

/**
 * The chat's own level (an Agent Slider stop, or the new-chat pick's level
 * for an empty chat) wins. Otherwise the first family that supports the
 * current model supplies its saved per-model level, in the order Google,
 * Codex, Anthropic, then any other provider; a model none of them supports
 * sends no level.
 */
export function turnThinkingLevel(
  selectionLevel: GenerationThinkingLevel | null | undefined,
  saved: {
    google: SavedThinkingPreference;
    codex: SavedThinkingPreference;
    anthropic: SavedThinkingPreference;
    provider: SavedThinkingPreference;
  },
): GenerationThinkingLevel | undefined {
  if (selectionLevel) return selectionLevel;
  for (const family of [saved.google, saved.codex, saved.anthropic, saved.provider]) {
    if (family.supported) return family.level;
  }
  return undefined;
}
