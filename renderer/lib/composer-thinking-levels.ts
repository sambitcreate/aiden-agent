// The reasoning efforts the composer offers for one model, by the same rules
// chat-pane's ThinkingControl branches use (Google, Codex, Anthropic, then
// built-in and effort-controlled custom providers), plus the level that
// applies when nothing was chosen. The Agent Slider uses it to seed a model's
// effort ladder and to give a reassigned stop its default level.

import {
  ANTHROPIC_THINKING_LEVELS,
  normalizeAnthropicThinkingLevel,
} from "../shared/anthropic-thinking";
import { CODEX_THINKING_LEVELS, normalizeCodexThinkingLevel } from "../shared/codex-thinking";
import { customModelThinkingLevels } from "../shared/custom-model-options";
import {
  isGenerationThinkingLevel,
  type GenerationThinkingLevel,
} from "../shared/generation-thinking";
import { GOOGLE_PROVIDER_ID } from "../shared/google-provider";
import { GOOGLE_THINKING_LEVELS, normalizeGoogleThinkingLevel } from "../shared/google-thinking";
import { normalizeProviderThinkingLevel } from "../shared/provider-thinking";
import { OPENAI_CODEX_PROVIDER_ID, type Provider } from "./types";

/** As chat-pane names it. */
const ANTHROPIC_PROVIDER_ID = "anthropic";

export interface ComposerThinkingLevels {
  /** Lowest to highest; empty when the composer offers no effort for the model. */
  levels: GenerationThinkingLevel[];
  /** The level used when none was saved for the model; absent with no levels. */
  defaultLevel?: GenerationThinkingLevel;
}

const NONE: ComposerThinkingLevels = { levels: [] };

/**
 * `reasoning` is the catalog's word on the model (`ModelInfo.reasoning`); a
 * model not known to reason gets no levels, as in the composer.
 */
export function composerThinkingLevels(
  provider: Pick<Provider, "id" | "kind" | "isBuiltin" | "modelMetadata"> | undefined,
  model: string,
  reasoning: boolean | undefined,
): ComposerThinkingLevels {
  if (!provider || !model || reasoning !== true) return NONE;
  const metadata = provider.modelMetadata?.[model];
  const declared = metadata?.thinkingLevels;
  if (provider.id === GOOGLE_PROVIDER_ID) {
    const supported = declared?.length
      ? GOOGLE_THINKING_LEVELS.filter((level) => declared.includes(level))
      : [...GOOGLE_THINKING_LEVELS];
    const levels = supported.includes("off") ? supported : (["off", ...supported] as const);
    return { levels: [...levels], defaultLevel: normalizeGoogleThinkingLevel(levels, undefined) };
  }
  if (provider.id === OPENAI_CODEX_PROVIDER_ID) {
    const levels = declared?.length ? CODEX_THINKING_LEVELS.filter((level) => declared.includes(level)) : [];
    return levels.length ? { levels, defaultLevel: normalizeCodexThinkingLevel(levels, undefined) } : NONE;
  }
  if (provider.id === ANTHROPIC_PROVIDER_ID) {
    const levels = declared?.length
      ? ANTHROPIC_THINKING_LEVELS.filter((level) => declared.includes(level))
      : [];
    return levels.length ? { levels, defaultLevel: normalizeAnthropicThinkingLevel(levels, undefined) } : NONE;
  }
  const custom = provider.kind === "openai" ? customModelThinkingLevels(metadata?.overrides) : undefined;
  if (provider.isBuiltin !== true && !custom) return NONE;
  const levels = custom ?? declared?.filter(isGenerationThinkingLevel) ?? [];
  return levels.length ? { levels, defaultLevel: normalizeProviderThinkingLevel(levels, undefined) } : NONE;
}
