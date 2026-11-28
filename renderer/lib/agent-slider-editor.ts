// The Agent Slider editor's edits (Settings → Agent Slider), kept pure so each
// one is a whole new slider that main's patch parser accepts: add, remove,
// move, rename, reassign, effort, home, and the two templates. Nothing here
// ranks models by scores or price.

import {
  AGENT_SLIDER_LABEL_MAX,
  AGENT_SLIDER_MAX_STOPS,
  AGENT_SLIDER_MIN_STOPS,
  agentSliderLabelProblem,
  randomStopId,
  seedAgentSlider,
  type AgentSliderSettings,
  type AgentSliderStop,
} from "../shared/agent-slider";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";

/** A stop label as typed, in words when it can't be saved. */
export function agentSliderLabelError(value: string): string | undefined {
  switch (agentSliderLabelProblem(value)) {
    case "empty":
      return "Give this stop a name.";
    case "too-long":
      return `Use ${AGENT_SLIDER_LABEL_MAX} characters or fewer.`;
    case "control-characters":
      return "Remove the control characters from this name.";
    default:
      return undefined;
  }
}

export const ADD_STOP_LIMIT_REASON = `The slider holds up to ${AGENT_SLIDER_MAX_STOPS} stops.`;
export const REMOVE_STOP_LIMIT_REASON = `The slider needs at least ${AGENT_SLIDER_MIN_STOPS} stops. Add one first.`;

function middle(stops: readonly AgentSliderStop[]): AgentSliderStop {
  return stops[Math.floor((stops.length - 1) / 2)]!;
}

function freshId(slider: AgentSliderSettings, makeId: () => string): string {
  const taken = new Set(slider.stops.map((stop) => stop.id));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = makeId();
    if (!taken.has(id)) return id;
  }
  throw new Error("Could not create a unique slider stop id.");
}

/** "Stop 4" for a fourth stop, or the next number no stop is called yet. */
export function nextStopLabel(slider: AgentSliderSettings): string {
  const taken = new Set(slider.stops.map((stop) => stop.label.toLocaleLowerCase()));
  for (let number = slider.stops.length + 1; ; number += 1) {
    const label = `Stop ${number}`;
    if (!taken.has(label.toLocaleLowerCase())) return label;
  }
}

/** A "Choose a model" stop at the right end; unchanged at 7 stops. */
export function addAgentSliderStop(
  slider: AgentSliderSettings,
  makeId: () => string = randomStopId,
): AgentSliderSettings {
  if (slider.stops.length >= AGENT_SLIDER_MAX_STOPS) return slider;
  const stop: AgentSliderStop = { id: freshId(slider, makeId), label: nextStopLabel(slider) };
  return { ...slider, stops: [...slider.stops, stop] };
}

/** Without the stop; unchanged at 3 stops. A removed home moves to the middle stop. */
export function removeAgentSliderStop(
  slider: AgentSliderSettings,
  stopId: string,
): AgentSliderSettings {
  if (slider.stops.length <= AGENT_SLIDER_MIN_STOPS) return slider;
  const stops = slider.stops.filter((stop) => stop.id !== stopId);
  if (stops.length === slider.stops.length) return slider;
  const homeStopId = stops.some((stop) => stop.id === slider.homeStopId)
    ? slider.homeStopId
    : middle(stops).id;
  return { ...slider, stops, homeStopId };
}

/** The stop one place left (-1) or right (1); unchanged at either end. */
export function moveAgentSliderStop(
  slider: AgentSliderSettings,
  stopId: string,
  direction: -1 | 1,
): AgentSliderSettings {
  const from = slider.stops.findIndex((stop) => stop.id === stopId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= slider.stops.length) return slider;
  const stops = [...slider.stops];
  [stops[from], stops[to]] = [stops[to]!, stops[from]!];
  return { ...slider, stops };
}

function updateStop(
  slider: AgentSliderSettings,
  stopId: string,
  update: (stop: AgentSliderStop) => AgentSliderStop,
): AgentSliderSettings {
  let changed = false;
  const stops = slider.stops.map((stop) => {
    if (stop.id !== stopId) return stop;
    const next = update(stop);
    changed ||= next !== stop;
    return next;
  });
  return changed ? { ...slider, stops } : slider;
}

/** A valid label, trimmed; an invalid one leaves the slider as it was. */
export function renameAgentSliderStop(
  slider: AgentSliderSettings,
  stopId: string,
  label: string,
): AgentSliderSettings {
  if (agentSliderLabelProblem(label)) return slider;
  const trimmed = label.trim();
  return updateStop(slider, stopId, (stop) =>
    stop.label === trimmed ? stop : { ...stop, label: trimmed },
  );
}

/**
 * Put a model on a stop. The stop keeps its effort when the new model offers
 * it, and otherwise takes the model's default; a model without levels has none.
 */
export function assignAgentSliderStop(
  slider: AgentSliderSettings,
  stopId: string,
  choice: {
    providerId: string;
    model: string;
    levels: readonly GenerationThinkingLevel[];
    defaultLevel?: GenerationThinkingLevel;
  },
): AgentSliderSettings {
  return updateStop(slider, stopId, (stop) => {
    const { thinkingLevel: previous, ...rest } = stop;
    const thinkingLevel =
      previous && choice.levels.includes(previous)
        ? previous
        : choice.levels.length
          ? (choice.defaultLevel ?? choice.levels[0])
          : undefined;
    if (
      stop.providerId === choice.providerId &&
      stop.model === choice.model &&
      stop.thinkingLevel === thinkingLevel
    ) {
      return stop;
    }
    return {
      ...rest,
      providerId: choice.providerId,
      model: choice.model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  });
}

export function setAgentSliderStopEffort(
  slider: AgentSliderSettings,
  stopId: string,
  thinkingLevel: GenerationThinkingLevel,
): AgentSliderSettings {
  return updateStop(slider, stopId, (stop) =>
    stop.thinkingLevel === thinkingLevel ? stop : { ...stop, thinkingLevel },
  );
}

export function setAgentSliderHome(
  slider: AgentSliderSettings,
  stopId: string,
): AgentSliderSettings {
  if (slider.homeStopId === stopId || !slider.stops.some((stop) => stop.id === stopId)) {
    return slider;
  }
  return { ...slider, homeStopId: stopId };
}

/** Same stops in the same order with the same home. */
export function sameAgentSlider(
  left: AgentSliderSettings | undefined,
  right: AgentSliderSettings | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** A model the effort ladder can be built on: 3 or more levels. */
export interface AgentSliderLadderModel {
  providerId: string;
  model: string;
  levels: readonly GenerationThinkingLevel[];
}

/**
 * "Effort ladder": one stop per level of one model, lowest to highest (at most
 * 7), each named for its level, with home in the middle. Undefined for a model
 * with fewer than 3 levels.
 */
export function effortLadderTemplate(
  ladder: AgentSliderLadderModel,
  makeId: () => string = randomStopId,
): AgentSliderSettings | undefined {
  if (ladder.levels.length < AGENT_SLIDER_MIN_STOPS) return undefined;
  return seedAgentSlider(
    { providerId: ladder.providerId, model: ladder.model },
    ladder.levels,
    makeId,
  );
}

/** A model a template may put on a stop, with the effort it starts at. */
export interface AgentSliderTemplateModel {
  providerId: string;
  model: string;
  thinkingLevel?: GenerationThinkingLevel;
}

/**
 * "Local to cloud": Local, Balanced and Cloud. Local takes the first local
 * model offered, Cloud the new-chat model when it is a cloud one; Balanced is
 * left for the person to choose. Home is the middle stop.
 */
export function localToCloudTemplate(
  {
    local,
    cloud,
  }: { local: AgentSliderTemplateModel | undefined; cloud: AgentSliderTemplateModel | undefined },
  makeId: () => string = randomStopId,
): AgentSliderSettings {
  const used = new Set<string>();
  const id = () => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const next = makeId();
      if (!used.has(next)) {
        used.add(next);
        return next;
      }
    }
    throw new Error("Could not create a unique slider stop id.");
  };
  const stop = (label: string, model: AgentSliderTemplateModel | undefined): AgentSliderStop => ({
    id: id(),
    label,
    ...(model
      ? {
          providerId: model.providerId,
          model: model.model,
          ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
        }
      : {}),
  });
  const stops = [stop("Local", local), stop("Balanced", undefined), stop("Cloud", cloud)];
  return { version: 1, stops, homeStopId: stops[1]!.id };
}
