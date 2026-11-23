// The Agent Slider: 3 to 7 ordered stops, each naming the model and reasoning
// effort that answer a chat's next turn. Shared by the main process
// (settings normalization, provider remap, the settings patch), the renderer
// and the CLI bundle, so it stays pure: no DOM, no Node APIs.

import { BOT_THINKING_LEVEL_LABELS } from "./bot-routine-models.js";
import { MAX_MODEL_ID_CHARS, MAX_PROVIDER_ID_CHARS } from "./chat-message-contract.js";
import {
  isGenerationThinkingLevel,
  type GenerationThinkingLevel,
} from "./generation-thinking.js";
import { isModelHidden, type HiddenModelsByProvider } from "./model-visibility.js";

export const AGENT_SLIDER_MIN_STOPS = 3;
export const AGENT_SLIDER_MAX_STOPS = 7;
/** Longest stop label, in code points after trimming. */
export const AGENT_SLIDER_LABEL_MAX = 24;

export interface AgentSliderStop {
  /** UI identity only: "stop_" + 8 lowercase hex for generated stops. */
  id: string;
  label: string;
  /** Present together with `model`; both absent is a "Choose a model" stop. */
  providerId?: string;
  model?: string;
  /** Absent: the model has no levels, or its saved level applies. */
  thinkingLevel?: GenerationThinkingLevel;
}

export interface AgentSliderSettings {
  version: 1;
  /** Left to right. */
  stops: AgentSliderStop[];
  /** The stop ↺ returns to. */
  homeStopId: string;
}

const STOP_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// C0/C1 controls, line and paragraph separators, and bidi embedding/isolate controls.
function isForbiddenLabelCodePoint(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  const codePoints = Array.from(label, (character) => character.codePointAt(0)!);
  if (codePoints.length === 0 || codePoints.length > AGENT_SLIDER_LABEL_MAX) return undefined;
  return codePoints.some(isForbiddenLabelCodePoint) ? undefined : label;
}

function validProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_ID_CHARS &&
    value.trim() === value
  );
}

function validModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_MODEL_ID_CHARS
  );
}

type StopResult = { stop: AgentSliderStop } | { error: string };

/**
 * One stop. `strictLevel` refuses an unknown thinking level; otherwise the
 * level alone is dropped and the stop survives.
 */
function parseStop(value: unknown, strictLevel: boolean): StopResult {
  if (!isRecord(value)) return { error: "Each slider stop must be an object." };
  if (typeof value.id !== "string" || !STOP_ID.test(value.id)) {
    return { error: "A slider stop has an invalid id." };
  }
  const label = validLabel(value.label);
  if (!label) {
    return {
      error: `Slider stop names need 1 to ${AGENT_SLIDER_LABEL_MAX} characters and no control characters.`,
    };
  }
  const hasProvider = value.providerId !== undefined;
  const hasModel = value.model !== undefined;
  if (hasProvider !== hasModel) {
    return { error: "A slider stop needs both a provider and a model, or neither." };
  }
  if (hasProvider && (!validProviderId(value.providerId) || !validModel(value.model))) {
    return { error: "A slider stop names an invalid provider or model." };
  }
  let thinkingLevel: GenerationThinkingLevel | undefined;
  if (value.thinkingLevel !== undefined) {
    if (isGenerationThinkingLevel(value.thinkingLevel)) thinkingLevel = value.thinkingLevel;
    else if (strictLevel) return { error: "A slider stop has an invalid thinking level." };
  }
  return {
    stop: {
      id: value.id,
      label,
      ...(hasProvider ? { providerId: value.providerId as string, model: value.model as string } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
  };
}

function middleIndex(count: number): number {
  return Math.floor((count - 1) / 2);
}

/**
 * Stored slider settings, fail-closed and lenient: malformed stops are
 * dropped, repeated ids keep their first stop, and the list is cut to 7. Fewer
 * than 3 valid stops leaves no slider. A home that names no stop moves to the
 * middle one.
 */
export function normalizeAgentSlider(value: unknown): AgentSliderSettings | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.stops)) return undefined;
  const stops: AgentSliderStop[] = [];
  const ids = new Set<string>();
  for (const raw of value.stops) {
    if (stops.length >= AGENT_SLIDER_MAX_STOPS) break;
    const parsed = parseStop(raw, false);
    if ("error" in parsed || ids.has(parsed.stop.id)) continue;
    ids.add(parsed.stop.id);
    stops.push(parsed.stop);
  }
  if (stops.length < AGENT_SLIDER_MIN_STOPS) return undefined;
  const homeStopId =
    typeof value.homeStopId === "string" && ids.has(value.homeStopId)
      ? value.homeStopId
      : stops[middleIndex(stops.length)]!.id;
  return { version: 1, stops, homeStopId };
}

/** A whole slider sent from the renderer: anything malformed is refused, never repaired. */
export function parseAgentSliderPatch(value: unknown): AgentSliderSettings {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Invalid Agent Slider settings.");
  }
  if (!Array.isArray(value.stops)) throw new Error("The Agent Slider needs a list of stops.");
  if (value.stops.length < AGENT_SLIDER_MIN_STOPS || value.stops.length > AGENT_SLIDER_MAX_STOPS) {
    throw new Error(
      `The Agent Slider holds ${AGENT_SLIDER_MIN_STOPS} to ${AGENT_SLIDER_MAX_STOPS} stops.`,
    );
  }
  const stops: AgentSliderStop[] = [];
  const ids = new Set<string>();
  for (const raw of value.stops) {
    const parsed = parseStop(raw, true);
    if ("error" in parsed) throw new Error(parsed.error);
    if (ids.has(parsed.stop.id)) throw new Error("Two slider stops share an id.");
    ids.add(parsed.stop.id);
    stops.push(parsed.stop);
  }
  if (typeof value.homeStopId !== "string" || !ids.has(value.homeStopId)) {
    throw new Error("The Agent Slider's home stop must be one of its stops.");
  }
  return { version: 1, stops, homeStopId: value.homeStopId };
}

/**
 * The slider-related fields of a `settings:set` patch. `lastThinkingLevel:
 * null` comes back present and `undefined`, which clears it; an unknown level
 * throws. The slider itself lives in the portable config and is refused here:
 * it changes only through `settings:setAgentSlider`.
 */
export function parseAgentSliderSettingsPatch(
  patch: Record<string, unknown>,
): { lastThinkingLevel?: GenerationThinkingLevel | undefined } {
  if (patch.agentSlider !== undefined) {
    throw new Error("The Agent Slider changes only through its own settings call.");
  }
  const result: { lastThinkingLevel?: GenerationThinkingLevel | undefined } = {};
  if (patch.lastThinkingLevel !== undefined) {
    if (patch.lastThinkingLevel !== null && !isGenerationThinkingLevel(patch.lastThinkingLevel)) {
      throw new Error("Invalid thinking level.");
    }
    result.lastThinkingLevel = patch.lastThinkingLevel ?? undefined;
  }
  return result;
}

/** Re-home every stop on a renamed provider. Other stops are untouched. */
export function remapAgentSliderProvider(
  slider: AgentSliderSettings,
  fromProviderId: string,
  toProviderId: string,
): AgentSliderSettings {
  return {
    ...slider,
    stops: slider.stops.map((stop) =>
      stop.providerId === fromProviderId ? { ...stop, providerId: toProviderId } : { ...stop },
    ),
  };
}

/**
 * What a stop is checked against. The renderer's and main's `Provider` both
 * fit `providers` as they are.
 */
export interface AgentSliderInventory {
  providers: readonly {
    id: string;
    models: readonly string[];
    needsKey?: boolean;
    hasKey?: boolean;
  }[];
  hiddenModelsByProvider?: HiddenModelsByProvider;
}

export type AgentSliderStopUnavailableReason =
  | "unassigned"
  | "provider-missing"
  | "not-signed-in"
  | "model-missing"
  | "hidden";

export type AgentSliderStopResolution =
  | {
      ok: true;
      providerId: string;
      model: string;
      thinkingLevel?: GenerationThinkingLevel;
    }
  | { ok: false; reason: AgentSliderStopUnavailableReason };

/** Whether a stop can run now, or the first reason it cannot. Never substitutes another model. */
export function resolveAgentSliderStop(
  stop: AgentSliderStop,
  inventory: AgentSliderInventory,
): AgentSliderStopResolution {
  if (!stop.providerId || !stop.model) return { ok: false, reason: "unassigned" };
  const provider = inventory.providers.find((candidate) => candidate.id === stop.providerId);
  if (!provider) return { ok: false, reason: "provider-missing" };
  if (provider.needsKey && !provider.hasKey) return { ok: false, reason: "not-signed-in" };
  if (!provider.models.includes(stop.model)) return { ok: false, reason: "model-missing" };
  if (isModelHidden(inventory.hiddenModelsByProvider, stop.providerId, stop.model)) {
    return { ok: false, reason: "hidden" };
  }
  return {
    ok: true,
    providerId: stop.providerId,
    model: stop.model,
    ...(stop.thinkingLevel ? { thinkingLevel: stop.thinkingLevel } : {}),
  };
}

export interface AgentSliderSelection {
  providerId: string;
  model: string;
  thinkingLevel?: GenerationThinkingLevel | null;
}

/**
 * The first stop naming this provider, model and level (an absent level
 * matches only an absent level). -1 is Custom. Unassigned stops never match.
 */
export function activeStopIndex(
  slider: AgentSliderSettings,
  selection: AgentSliderSelection,
): number {
  const level = selection.thinkingLevel ?? undefined;
  return slider.stops.findIndex(
    (stop) =>
      stop.providerId !== undefined &&
      stop.model !== undefined &&
      stop.providerId === selection.providerId &&
      stop.model === selection.model &&
      stop.thinkingLevel === level,
  );
}

function randomStopId(): string {
  const bytes = new Uint8Array(4);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `stop_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The first-run slider. A model with 3 or more levels gets its own effort
 * ladder, one stop per level, with home on the current level (else the
 * middle). Any other model sits in the middle, as home, between two
 * "Choose a model" stops.
 */
export function seedAgentSlider(
  selection: { providerId: string; model: string; thinkingLevel?: GenerationThinkingLevel },
  levels: readonly GenerationThinkingLevel[],
  makeId: () => string = randomStopId,
): AgentSliderSettings {
  const used = new Set<string>();
  const nextId = (): string => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = makeId();
      if (STOP_ID.test(id) && !used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error("Could not create a unique slider stop id.");
  };
  const assigned = selection.providerId && selection.model
    ? { providerId: selection.providerId, model: selection.model }
    : {};
  const ladder = [...new Set(levels.filter(isGenerationThinkingLevel))];
  if (ladder.length >= AGENT_SLIDER_MIN_STOPS && "providerId" in assigned) {
    let kept = ladder.slice(0, AGENT_SLIDER_MAX_STOPS);
    const current = selection.thinkingLevel;
    if (current && ladder.includes(current) && !kept.includes(current)) {
      kept = [...kept.slice(0, AGENT_SLIDER_MAX_STOPS - 1), current];
    }
    const stops = kept.map((thinkingLevel) => ({
      id: nextId(),
      label: BOT_THINKING_LEVEL_LABELS[thinkingLevel],
      ...assigned,
      thinkingLevel,
    }));
    const home =
      stops.find((stop) => stop.thinkingLevel === current) ?? stops[middleIndex(stops.length)]!;
    return { version: 1, stops, homeStopId: home.id };
  }
  const fastId = nextId();
  const balanced: AgentSliderStop = {
    id: nextId(),
    label: "Balanced",
    ...assigned,
    ...(selection.thinkingLevel && "providerId" in assigned
      ? { thinkingLevel: selection.thinkingLevel }
      : {}),
  };
  return {
    version: 1,
    stops: [{ id: fastId, label: "Fast" }, balanced, { id: nextId(), label: "Smart" }],
    homeStopId: balanced.id,
  };
}
