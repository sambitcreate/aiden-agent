import type { Api, Model } from "@earendil-works/pi-ai";
import {
  anthropicThinkingCanDisable,
  anthropicThinkingLevelsForModel,
} from "../../renderer/shared/anthropic-thinking.js";
import {
  googleThinkingCanDisable,
  googleThinkingLevelsForModel,
} from "../../renderer/shared/google-thinking.js";
import { isGenerationThinkingLevel } from "../../renderer/shared/generation-thinking.js";
import type { ProviderModelMetadata } from "./types.js";

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Pi treats an absent ordinary-level mapping as native support, an explicit
 * null as unsupported, and requires an explicit mapping for xhigh/max.
 * Keep Aiden's UI and runtime on that same contract while the Pi package is pinned.
 */
export function piThinkingLevelsForModel(
  model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
): ProviderModelMetadata["thinkingLevels"] {
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  }).filter(isGenerationThinkingLevel);
}

/** Project Pi's executable model contract into renderer and remote-client metadata. */
export function piModelMetadataFor(providerId: string, model: Model<Api>): ProviderModelMetadata {
  const thinking =
    providerId === "anthropic"
      ? {
          thinkingLevels: anthropicThinkingLevelsForModel(model),
          thinkingCanDisable: anthropicThinkingCanDisable(model),
        }
      : providerId === "google"
        ? {
            thinkingLevels: googleThinkingLevelsForModel(model),
            thinkingCanDisable: googleThinkingCanDisable(model),
          }
        : model.reasoning
          ? {
              thinkingLevels: piThinkingLevelsForModel(model),
              thinkingCanDisable: model.thinkingLevelMap?.off !== null,
            }
          : {};
  return {
    source: "provider",
    name: model.name,
    type: "llm",
    vision: model.input.includes("image"),
    reasoning: model.reasoning,
    ...thinking,
    contextLength: model.contextWindow,
  };
}
