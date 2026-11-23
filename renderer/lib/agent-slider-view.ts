// What the composer shows for the Agent Slider: each stop's words and whether
// it can run, where the thumb sits, and which stop a step lands on. Shared by
// the popover, the composer's step shortcuts and Quick Chat, so the arrow
// keys and ⌥⌘[ / ⌥⌘] follow the same skip rules.

import {
  activeStopIndex,
  resolveAgentSliderStop,
  type AgentSliderInventory,
  type AgentSliderSelection,
  type AgentSliderSettings,
  type AgentSliderStopUnavailableReason,
} from "../shared/agent-slider";
import { BOT_THINKING_LEVEL_LABELS } from "../shared/bot-routine-models";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import { parseModel } from "./model-picker-data";

export interface AgentSliderStopView {
  id: string;
  label: string;
  providerId?: string;
  model?: string;
  thinkingLevel?: GenerationThinkingLevel;
  /** The model's display name; absent for a "Choose a model" stop. */
  modelLabel?: string;
  /** The effort in words ("High"); absent when the stop has no level. */
  effortLabel?: string;
  available: boolean;
  reason?: AgentSliderStopUnavailableReason;
  /** Why the stop can't run, in words ("Sign in to Anthropic"). */
  reasonText?: string;
}

export interface AgentSliderLabels {
  /** A connected provider's name, if it is still listed. */
  providerLabel(providerId: string): string | undefined;
  /** A model's display name, if the catalog knows it. */
  modelLabel(providerId: string, model: string): string | undefined;
}

/** The reason a stop can't run, as the slider says it. */
export function unavailableStopText(
  reason: AgentSliderStopUnavailableReason,
  providerId: string | undefined,
  providerLabel: string | undefined,
): string {
  switch (reason) {
    case "unassigned":
      return "Choose a model";
    case "not-signed-in":
      return `Sign in to ${providerLabel ?? providerId ?? "the provider"}`;
    case "provider-missing":
      return `${providerLabel ?? providerId ?? "The provider"} was removed`;
    case "model-missing":
      return "Model not found";
    case "hidden":
      return "Hidden in Settings";
  }
}

export function effortLabel(level: GenerationThinkingLevel | undefined | null): string | undefined {
  return level ? BOT_THINKING_LEVEL_LABELS[level] : undefined;
}

export function agentSliderStopViews(
  slider: AgentSliderSettings,
  inventory: AgentSliderInventory,
  labels: AgentSliderLabels,
): AgentSliderStopView[] {
  return slider.stops.map((stop) => {
    const resolution = resolveAgentSliderStop(stop, inventory);
    const modelLabel =
      stop.providerId && stop.model
        ? (labels.modelLabel(stop.providerId, stop.model) ?? parseModel(stop.model).label)
        : undefined;
    const providerLabel = stop.providerId ? labels.providerLabel(stop.providerId) : undefined;
    return {
      id: stop.id,
      label: stop.label,
      ...(stop.providerId ? { providerId: stop.providerId } : {}),
      ...(stop.model ? { model: stop.model } : {}),
      ...(stop.thinkingLevel ? { thinkingLevel: stop.thinkingLevel } : {}),
      ...(modelLabel ? { modelLabel } : {}),
      ...(stop.thinkingLevel ? { effortLabel: effortLabel(stop.thinkingLevel) } : {}),
      available: resolution.ok,
      ...(resolution.ok
        ? {}
        : {
            reason: resolution.reason,
            reasonText: unavailableStopText(resolution.reason, stop.providerId, providerLabel),
          }),
    };
  });
}

export function homeStopIndex(slider: AgentSliderSettings): number {
  const index = slider.stops.findIndex((stop) => stop.id === slider.homeStopId);
  return index === -1 ? Math.floor((slider.stops.length - 1) / 2) : index;
}

export interface AgentSliderPosition {
  /** The stop the chat sits on, or -1 (Custom). */
  stopIndex: number;
  /** Where the thumb rests: the stop, or the home stop in Custom. */
  thumbIndex: number;
  custom: boolean;
}

/**
 * Where the chat sits. No matching stop is Custom, and so is every case where
 * no stop can run: the slider then has nothing to offer.
 */
export function agentSliderPosition(
  slider: AgentSliderSettings,
  views: readonly AgentSliderStopView[],
  selection: AgentSliderSelection,
): AgentSliderPosition {
  const home = homeStopIndex(slider);
  const index = activeStopIndex(slider, selection);
  if (index === -1 || !views.some((view) => view.available)) {
    return { stopIndex: -1, thumbIndex: home, custom: true };
  }
  return { stopIndex: index, thumbIndex: index, custom: false };
}

function nextAvailable(
  views: readonly AgentSliderStopView[],
  from: number,
  direction: 1 | -1,
): number {
  for (let index = from + direction; index >= 0 && index < views.length; index += direction) {
    if (views[index]?.available) return index;
  }
  return -1;
}

/**
 * The stop one step left (-1) or right (1) of the chat's, skipping stops that
 * can't run. Custom starts from the home stop; when nothing is that way, a
 * runnable home stop is the step, so a key always leaves Custom when it can.
 * -1 when the step goes nowhere.
 */
export function stepAgentSliderStop(
  views: readonly AgentSliderStopView[],
  position: AgentSliderPosition,
  direction: 1 | -1,
): number {
  const target = nextAvailable(views, position.thumbIndex, direction);
  if (target !== -1) return target;
  if (position.custom && views[position.thumbIndex]?.available) return position.thumbIndex;
  return -1;
}

/** The first (Home) or last (End) stop that can run, or -1. */
export function edgeAgentSliderStop(
  views: readonly AgentSliderStopView[],
  edge: "first" | "last",
): number {
  return edge === "first" ? nextAvailable(views, -1, 1) : nextAvailable(views, views.length, -1);
}

/** What a screen reader hears for the thumb. */
export function agentSliderValueText(
  views: readonly AgentSliderStopView[],
  position: AgentSliderPosition,
  customModelLabel: string,
): string {
  if (position.custom) return `Custom: ${customModelLabel}`;
  const view = views[position.stopIndex]!;
  return [
    view.label,
    view.modelLabel ?? "No model chosen",
    view.effortLabel,
    view.available ? undefined : view.reasonText,
  ]
    .filter(Boolean)
    .join(", ");
}

const NO_LABELS: AgentSliderLabels = {
  providerLabel: () => undefined,
  modelLabel: () => undefined,
};

export interface AgentSliderComposerState {
  views: AgentSliderStopView[];
  position: AgentSliderPosition;
}

/**
 * Where a composer's chat sits on the slider, without display names: enough
 * to hide the effort control on a stop that sets it and to step with ⌥⌘[ / ⌥⌘]. Absent
 * until a slider is saved.
 */
export function agentSliderComposerState(
  slider: AgentSliderSettings | undefined,
  inventory: AgentSliderInventory,
  selection: AgentSliderSelection,
): AgentSliderComposerState | undefined {
  if (!slider) return undefined;
  const views = agentSliderStopViews(slider, inventory, NO_LABELS);
  return { views, position: agentSliderPosition(slider, views, selection) };
}

/**
 * Whether the chat's stop sets the effort, so the composer's effort control
 * hides. A stop without a level leaves effort to the model's own setting, and
 * Custom shows the control as before.
 */
export function agentSliderStopSetsEffort(state: AgentSliderComposerState | undefined): boolean {
  if (!state || state.position.custom) return false;
  return Boolean(state.views[state.position.stopIndex]?.thinkingLevel);
}

/** The stop a step shortcut moves to, or undefined when it goes nowhere. */
export function agentSliderStepTarget(
  state: AgentSliderComposerState | undefined,
  direction: 1 | -1,
): AgentSliderStopView | undefined {
  if (!state) return undefined;
  const index = stepAgentSliderStop(state.views, state.position, direction);
  if (index === -1 || index === state.position.stopIndex) return undefined;
  const view = state.views[index];
  return view?.available && view.providerId && view.model ? view : undefined;
}
