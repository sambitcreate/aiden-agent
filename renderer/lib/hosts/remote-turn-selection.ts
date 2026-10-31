import * as React from "react";
import type { GenerationThinkingLevel } from "../../shared/generation-thinking";
import type { HostTurnModel } from "./host-chat-adapter";
import { findHostModel, type HostModel, type HostModelCatalog, type HostModelChoice } from "./host-resources";

/**
 * The model and effort an open remote chat's next turn runs on. The host owns
 * both: a turn that names a model makes it the chat's model there (the rule
 * phones follow too), and a turn that names no effort runs at the host's
 * default for that model. This Mac only remembers what the person picked here
 * and sends it with each turn.
 */

export interface RemoteTurnPick {
  model?: HostModelChoice;
  thinkingLevel?: GenerationThinkingLevel;
}

export interface RemoteTurnSelection {
  /** The model the picker shows: a pick the host still lists, else the chat's own. */
  model: HostModelChoice | undefined;
  hostModel: HostModel | undefined;
  /** Effort levels the shown model runs at on the host; empty hides the control. */
  levels: GenerationThinkingLevel[];
  /** The effort the control shows: a pick the model lists, else the host's default. */
  thinkingLevel: GenerationThinkingLevel | undefined;
  canDisable: boolean;
  /** What the next turn sends: only what differs from the chat's own settings. */
  extras: { model?: HostTurnModel; thinkingLevel?: GenerationThinkingLevel };
}

const sameModel = (a: HostModelChoice | undefined, b: HostModelChoice | undefined) =>
  Boolean(a && b && a.providerId === b.providerId && a.modelId === b.modelId);

export function resolveRemoteTurnSelection(
  catalog: HostModelCatalog | undefined,
  chatModel: HostModelChoice | undefined,
  pick: RemoteTurnPick,
): RemoteTurnSelection {
  // A pick the host no longer lists falls back to the chat's own model.
  const picked = pick.model && (!catalog || findHostModel(catalog, pick.model)) ? pick.model : undefined;
  const model = picked ?? chatModel;
  const hostModel = findHostModel(catalog, model);
  const levels = hostModel?.thinkingLevels ?? [];
  const pickedLevel = pick.thinkingLevel && levels.includes(pick.thinkingLevel) ? pick.thinkingLevel : undefined;
  return {
    model,
    hostModel,
    levels,
    thinkingLevel: pickedLevel ?? hostModel?.defaultThinkingLevel ?? levels[0],
    canDisable: hostModel?.thinkingCanDisable ?? true,
    extras: {
      ...(picked && !sameModel(picked, chatModel) ? { model: { providerId: picked.providerId, modelId: picked.modelId } } : {}),
      ...(pickedLevel ? { thinkingLevel: pickedLevel } : {}),
    },
  };
}

// Picks outlive the pane, so reopening a chat keeps them, but never this app.
const picks = new Map<string, RemoteTurnPick>();

/** The pick for one remote chat (keyed by host and chat), kept while Aiden runs. */
export function useRemoteTurnPick(key: string | null) {
  const [pick, setPickState] = React.useState<RemoteTurnPick>(() => (key ? (picks.get(key) ?? {}) : {}));
  const [pickKey, setPickKey] = React.useState(key);
  if (pickKey !== key) {
    setPickKey(key);
    setPickState(key ? (picks.get(key) ?? {}) : {});
  }
  const update = React.useCallback(
    (next: RemoteTurnPick) => {
      if (key) picks.set(key, next);
      setPickState(next);
    },
    [key],
  );
  return [pick, update] as const;
}
