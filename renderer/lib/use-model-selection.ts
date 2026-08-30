// App-wide provider+model selection, persisted in localStorage (UI preference,
// not routed state). Defaults once when no selection exists, but never silently
// reroutes an existing selection to another provider.

import * as React from "react";
import { isUsable } from "./model-picker-data";
import type { AppSettings, Provider } from "./types";
import { telegramApi } from "./ipc";
import { firstVisibleModelForProvider, isModelHidden } from "../shared/model-visibility";

const PROVIDER_KEY = "aiden-agent.providerId";
const MODEL_KEY = "aiden-agent.model";
const MODEL_SELECTION_CHANGED_EVENT = "aiden:model-selection-changed";
let modelSelectionRevision = 0;

export interface ModelSelection {
  providerId: string;
  model: string;
}

/**
 * The current selection straight from storage.
 *
 * The hook and follower surfaces subscribe to the same event-backed storage
 * source, so selecting in the command palette immediately updates the active
 * composer and Aiden dock.
 */
export function readModelSelection(): ModelSelection {
  return {
    providerId: localStorage.getItem(PROVIDER_KEY) ?? "",
    model: localStorage.getItem(MODEL_KEY) ?? "",
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
    if (event.key === PROVIDER_KEY || event.key === MODEL_KEY || event.key === null) {
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

export function persistModelSelection(providerId: string, model: string): void {
  localStorage.setItem(PROVIDER_KEY, providerId);
  localStorage.setItem(MODEL_KEY, model);
  modelSelectionRevision += 1;
  window.dispatchEvent(new Event(MODEL_SELECTION_CHANGED_EVENT));
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

  React.useEffect(
    () =>
      subscribeModelSelection((selection) => {
        setProviderId(selection.providerId);
        setModel(selection.model);
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
      persistModelSelection(next.providerId, next.model);
    }
  }, [providers, providerId, model, hiddenModelsByProvider, visibilityLoaded]);

  const select = React.useCallback((pid: string, m: string) => {
    setProviderId(pid);
    setModel(m);
    persistModelSelection(pid, m);
  }, []);

  return { providerId, model, select };
}
