// Saving the Agent Slider from the renderer: the first-run seed (written only
// while config.json holds no slider, so a malformed hand edit is never
// replaced) and whole-slider writes such as a reassigned stop. Each keeps the
// settings query in step with what main saved.

import type { QueryClient } from "@tanstack/react-query";
import { seedAgentSlider, type AgentSliderSettings } from "../shared/agent-slider";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import { composerThinkingLevels } from "./composer-thinking-levels";
import { modelsApi, settingsApi } from "./ipc";
import { queryKeys } from "./queries";
import type { AppSettings, Provider } from "./types";

/** Put main's slider into the cached settings, leaving every other field as it is. */
export function cacheAgentSlider(queryClient: QueryClient, saved: AppSettings): void {
  queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => {
    if (!current) return saved;
    const { agentSlider: _previous, ...rest } = current;
    return saved.agentSlider ? { ...rest, agentSlider: saved.agentSlider } : rest;
  });
}

/**
 * Seed the slider from the model in use, once. Without a model there is
 * nothing to build it around, so nothing is written. Resolves to the slider
 * main now holds (absent when a malformed hand edit stands in its place).
 */
export async function seedAgentSliderIfAbsent(
  selection: { providerId: string; model: string; thinkingLevel?: GenerationThinkingLevel },
  levels: readonly GenerationThinkingLevel[],
  queryClient?: QueryClient,
): Promise<AgentSliderSettings | undefined> {
  if (!selection.providerId || !selection.model) return undefined;
  const saved = await settingsApi.seedAgentSlider(seedAgentSlider(selection, levels));
  if (queryClient) cacheAgentSlider(queryClient, saved);
  return saved.agentSlider;
}

/**
 * Seed from a model just chosen outside the composer (onboarding's provider
 * step). Its effort ladder comes from the catalog, read once; without catalog
 * word the model gets the Fast / Balanced / Smart seed.
 */
export async function seedAgentSliderForModel(
  provider: Provider | undefined,
  providerId: string,
  model: string,
  queryClient?: QueryClient,
): Promise<AgentSliderSettings | undefined> {
  let reasoning: boolean | undefined;
  try {
    reasoning = (await modelsApi.info(providerId, [model]))[model]?.reasoning;
  } catch {
    reasoning = undefined;
  }
  const { levels } = composerThinkingLevels(provider, model, reasoning);
  return seedAgentSliderIfAbsent({ providerId, model }, levels, queryClient);
}

/** Replace the whole slider and cache what main saved. */
export async function saveAgentSlider(
  slider: AgentSliderSettings,
  queryClient?: QueryClient,
): Promise<AgentSliderSettings | undefined> {
  const saved = await settingsApi.setAgentSlider(slider);
  if (queryClient) cacheAgentSlider(queryClient, saved);
  return saved.agentSlider;
}
