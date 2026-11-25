// The app's model for new chats, persisted in localStorage (UI preference, not
// routed state). Defaults once when no selection exists, but never silently
// reroutes an existing selection to another provider. A chat that already has
// messages keeps its own model (stored on the chat); picking a model there
// changes only that chat, never this selection.

import * as React from "react";
import { isUsable } from "./model-picker-data";
import type { AppSettings, Provider } from "./types";
import { onNotification, settingsApi, telegramApi } from "./ipc";
import { firstVisibleModelForProvider, isModelHidden } from "../shared/model-visibility";
import { isGenerationThinkingLevel, type GenerationThinkingLevel } from "../shared/generation-thinking";

const PROVIDER_KEY = "aiden-agent.providerId";
const MODEL_KEY = "aiden-agent.model";
/** The new-chat model's own reasoning effort; absent: the model's saved level. */
const THINKING_LEVEL_KEY = "aiden-agent.thinkingLevel";
const MODEL_SELECTION_CHANGED_EVENT = "aiden:model-selection-changed";
let modelSelectionRevision = 0;

export interface ModelSelection {
  providerId: string;
  model: string;
  /** The effort picked with this model (an Agent Slider stop); absent: the model's saved level. */
  thinkingLevel?: GenerationThinkingLevel;
}

function readThinkingLevel(): GenerationThinkingLevel | undefined {
  const stored = localStorage.getItem(THINKING_LEVEL_KEY);
  return isGenerationThinkingLevel(stored) ? stored : undefined;
}

/**
 * The current selection straight from storage.
 *
 * The hook and follower surfaces subscribe to the same event-backed storage
 * source, so selecting in the command palette immediately updates the active
 * composer and Aiden dock.
 */
export function readModelSelection(): ModelSelection {
  const thinkingLevel = readThinkingLevel();
  return {
    providerId: localStorage.getItem(PROVIDER_KEY) ?? "",
    model: localStorage.getItem(MODEL_KEY) ?? "",
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/** Monotonic same-process revision used to reject stale async model choices. */
export function readModelSelectionRevision(): number {
  return modelSelectionRevision;
}

/** True only when the stored pair still names a usable model in the live provider list. */
export function isModelSelectionAvailable(
  selection: ModelSelection,
  providers: Provider[] | undefined,
): boolean {
  const provider = providers?.find((candidate) => candidate.id === selection.providerId);
  return Boolean(provider && isUsable(provider) && provider.models.includes(selection.model));
}

/** Existing chats may retain hidden models; empty chats must use a visible selection. */
export function isModelSelectionReadyForNewWork(
  selection: ModelSelection,
  providers: Provider[] | undefined,
  hiddenModelsByProvider: AppSettings["hiddenModelsByProvider"],
  hasMessages: boolean,
): boolean {
  return (
    isModelSelectionAvailable(selection, providers) &&
    (hasMessages || !isModelHidden(hiddenModelsByProvider, selection.providerId, selection.model))
  );
}

/** Resolve the selection used for new work while leaving explicit legacy selections intact. */
export function resolveVisibleModelSelection(
  selection: ModelSelection,
  providers: Provider[] | undefined,
  hiddenModelsByProvider: AppSettings["hiddenModelsByProvider"],
): ModelSelection | undefined {
  if (
    isModelSelectionAvailable(selection, providers) &&
    !isModelHidden(hiddenModelsByProvider, selection.providerId, selection.model)
  ) {
    return selection;
  }
  for (const provider of providers ?? []) {
    if (!isUsable(provider)) continue;
    const model = firstVisibleModelForProvider(
      hiddenModelsByProvider,
      provider.id,
      provider.models,
      [provider.defaultModel],
    );
    if (model) return { providerId: provider.id, model };
  }
  return undefined;
}

/** Never choose a default until the presentation-visibility preference is authoritative. */
export function initialVisibleModelSelection(
  selection: ModelSelection,
  providers: Provider[] | undefined,
  hiddenModelsByProvider: AppSettings["hiddenModelsByProvider"],
  visibilityLoaded: boolean,
): ModelSelection | undefined {
  if (!visibilityLoaded) return undefined;
  return resolveVisibleModelSelection(selection, providers, hiddenModelsByProvider);
}

/** Subscribe follower surfaces to same-window writes, cross-window writes, and refocus refreshes. */
export function subscribeModelSelection(listener: (selection: ModelSelection) => void): () => void {
  const sync = () => listener(readModelSelection());
  const syncStorage = (event: StorageEvent) => {
    if (
      event.key === PROVIDER_KEY ||
      event.key === MODEL_KEY ||
      event.key === THINKING_LEVEL_KEY ||
      event.key === null
    ) {
      modelSelectionRevision += 1;
      sync();
    }
  };
  window.addEventListener(MODEL_SELECTION_CHANGED_EVENT, sync);
  window.addEventListener("storage", syncStorage);
  window.addEventListener("focus", sync);
  return () => {
    window.removeEventListener(MODEL_SELECTION_CHANGED_EVENT, sync);
    window.removeEventListener("storage", syncStorage);
    window.removeEventListener("focus", sync);
  };
}

/**
 * The model an open chat answers with. A chat that owns its model (it already
 * has messages) uses the pair, and its own level if it has one, stored on it;
 * an empty chat, or one that never recorded a model, follows the app's model
 * for new chats.
 */
export function chatModelSelection(
  chat: { providerId?: string; model?: string; thinkingLevel?: GenerationThinkingLevel } | null | undefined,
  chatOwnsModel: boolean,
  appSelection: ModelSelection,
): ModelSelection {
  if (chatOwnsModel && chat?.providerId && chat.model) {
    return {
      providerId: chat.providerId,
      model: chat.model,
      ...(chat.thinkingLevel ? { thinkingLevel: chat.thinkingLevel } : {}),
    };
  }
  return appSelection;
}

/**
 * The open chat whose own model a model change elsewhere (the command palette)
 * should change instead of the app's model for new chats.
 */
export interface ActiveChatModelTarget {
  chatId: string;
  selection: ModelSelection;
  select(providerId: string, model: string): void;
}

let activeChatModelTarget: ActiveChatModelTarget | null = null;
const activeChatModelTargetListeners = new Set<() => void>();

/** Register the open chat as the model target; returns its unregister. */
export function setActiveChatModelTarget(target: ActiveChatModelTarget): () => void {
  activeChatModelTarget = target;
  activeChatModelTargetListeners.forEach((listener) => listener());
  return () => {
    if (activeChatModelTarget !== target) return;
    activeChatModelTarget = null;
    activeChatModelTargetListeners.forEach((listener) => listener());
  };
}

export function readActiveChatModelTarget(): ActiveChatModelTarget | null {
  return activeChatModelTarget;
}

function subscribeActiveChatModelTarget(listener: () => void): () => void {
  activeChatModelTargetListeners.add(listener);
  return () => activeChatModelTargetListeners.delete(listener);
}

export function useActiveChatModelTarget(): ActiveChatModelTarget | null {
  return React.useSyncExternalStore(
    subscribeActiveChatModelTarget,
    readActiveChatModelTarget,
    () => null,
  );
}

/**
 * Save the model for new chats. A level picks that model's effort (an Agent
 * Slider stop); leaving it out clears any level, because a level belongs to
 * the model it was picked with.
 */
export function persistModelSelection(
  providerId: string,
  model: string,
  thinkingLevel?: GenerationThinkingLevel,
): void {
  const previous = readModelSelection();
  localStorage.setItem(PROVIDER_KEY, providerId);
  localStorage.setItem(MODEL_KEY, model);
  if (thinkingLevel) localStorage.setItem(THINKING_LEVEL_KEY, thinkingLevel);
  else localStorage.removeItem(THINKING_LEVEL_KEY);
  modelSelectionRevision += 1;
  window.dispatchEvent(new Event(MODEL_SELECTION_CHANGED_EVENT));
  // Keep the host's copy current so Aiden's "Model for new chats" control and
  // paired phones see the pick at once, not after the next chat starts.
  if (
    providerId &&
    model &&
    (previous.providerId !== providerId ||
      previous.model !== model ||
      previous.thinkingLevel !== thinkingLevel)
  ) {
    void Promise.resolve()
      .then(() => settingsApi.set(hostNewChatPatch({ providerId, model, thinkingLevel })))
      .catch(() => undefined);
  }
}

/** The host's copy of the new-chat pick; a pick without a level clears the host's. */
function hostNewChatPatch(selection: ModelSelection) {
  return {
    lastProviderId: selection.providerId,
    lastModel: selection.model,
    lastThinkingLevel: selection.thinkingLevel ?? null,
  };
}

/**
 * At startup, make the host's copy match this window's new-chat model. Sends
 * never write it, so this keeps Aiden's "Model for new chats" control and
 * paired phones on the pick the desktop will really use, even if the two drifted
 * apart while the app was closed or before the copy existed.
 */
export async function mirrorNewChatModelToHost(api: {
  get(): Promise<Pick<AppSettings, "lastProviderId" | "lastModel" | "lastThinkingLevel">>;
  set(patch: {
    lastProviderId: string;
    lastModel: string;
    lastThinkingLevel: GenerationThinkingLevel | null;
  }): Promise<unknown>;
}): Promise<void> {
  const host = await api.get();
  // Read the pick after the host answers: one made while the read was pending
  // is newer than anything captured before it.
  const selection = readModelSelection();
  if (!selection.providerId || !selection.model) return;
  if (
    host.lastProviderId === selection.providerId &&
    host.lastModel === selection.model &&
    host.lastThinkingLevel === selection.thinkingLevel
  ) {
    return;
  }
  await api.set(hostNewChatPatch(selection));
}

/** Follow a new-chat model the host changed (Aiden's chat control). */
export function subscribeHostNewChatModel(
  subscribe: typeof onNotification,
): () => void {
  return subscribe("settings:new-chat-model-changed", (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const { providerId, model } = payload as Record<string, unknown>;
    if (typeof providerId !== "string" || typeof model !== "string" || !providerId || !model) return;
    const current = readModelSelection();
    if (current.providerId === providerId && current.model === model) return;
    persistModelSelection(providerId, model);
  });
}

export function useModelSelection(
  providers: Provider[] | undefined,
  hiddenModelsByProvider: AppSettings["hiddenModelsByProvider"],
  visibilityLoaded: boolean,
) {
  const [providerId, setProviderId] = React.useState(
    () => localStorage.getItem(PROVIDER_KEY) ?? "",
  );
  const [model, setModel] = React.useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [thinkingLevel, setThinkingLevel] = React.useState(readThinkingLevel);

  React.useEffect(
    () =>
      subscribeModelSelection((selection) => {
        setProviderId(selection.providerId);
        setModel(selection.model);
        setThinkingLevel(selection.thinkingLevel);
      }),
    [],
  );

  React.useEffect(
    () =>
      telegramApi.onModelSelectionChanged((selection) => {
        persistModelSelection(selection.providerId, selection.model);
      }),
    [],
  );

  // Once providers load, choose an initial usable provider only when there is no
  // saved selection. A removed or unavailable provider must remain explicit so a
  // later chat cannot unexpectedly go to a hosted connection.
  React.useEffect(() => {
    if (!providers?.length) return;
    if (providerId || model) return;
    const next = initialVisibleModelSelection(
      { providerId: "", model: "" },
      providers,
      hiddenModelsByProvider,
      visibilityLoaded,
    );
    if (next) {
      setProviderId(next.providerId);
      setModel(next.model);
      setThinkingLevel(undefined);
      persistModelSelection(next.providerId, next.model);
    }
  }, [providers, providerId, model, hiddenModelsByProvider, visibilityLoaded]);

  const select = React.useCallback((pid: string, m: string, level?: GenerationThinkingLevel) => {
    setProviderId(pid);
    setModel(m);
    setThinkingLevel(level);
    persistModelSelection(pid, m, level);
  }, []);

  return { providerId, model, thinkingLevel, select };
}
