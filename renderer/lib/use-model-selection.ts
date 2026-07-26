// App-wide provider+model selection, persisted in localStorage (UI preference,
// not routed state). Defaults once when no selection exists, but never silently
// reroutes an existing selection to another provider.

import * as React from "react";
import { isUsable } from "./model-picker-data";
import type { Provider } from "./types";

const PROVIDER_KEY = "aiden-agent.providerId";
const MODEL_KEY = "aiden-agent.model";
const MODEL_SELECTION_CHANGED_EVENT = "aiden:model-selection-changed";

export interface ModelSelection {
  providerId: string;
  model: string;
}

/**
 * The current selection straight from storage.
 *
 * `useModelSelection` holds per-instance React state seeded once at mount, so
 * two mounted instances drift apart the moment one of them selects. Surfaces
 * that merely follow the user's choice — rather than owning it — should read
 * this at the point of use instead of mounting a second copy of the hook.
 */
export function readModelSelection(): ModelSelection {
  return {
    providerId: localStorage.getItem(PROVIDER_KEY) ?? "",
    model: localStorage.getItem(MODEL_KEY) ?? "",
  };
}

/** True only when the stored pair still names a usable model in the live provider list. */
export function isModelSelectionAvailable(
  selection: ModelSelection,
  providers: Provider[] | undefined,
): boolean {
  const provider = providers?.find((candidate) => candidate.id === selection.providerId);
  return Boolean(provider && isUsable(provider) && provider.models.includes(selection.model));
}

/** Subscribe follower surfaces to same-window writes, cross-window writes, and refocus refreshes. */
export function subscribeModelSelection(listener: (selection: ModelSelection) => void): () => void {
  const sync = () => listener(readModelSelection());
  const syncStorage = (event: StorageEvent) => {
    if (event.key === PROVIDER_KEY || event.key === MODEL_KEY || event.key === null) sync();
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

function persistModelSelection(providerId: string, model: string): void {
  localStorage.setItem(PROVIDER_KEY, providerId);
  localStorage.setItem(MODEL_KEY, model);
  window.dispatchEvent(new Event(MODEL_SELECTION_CHANGED_EVENT));
}

export function useModelSelection(providers: Provider[] | undefined) {
  const [providerId, setProviderId] = React.useState(
    () => localStorage.getItem(PROVIDER_KEY) ?? "",
  );
  const [model, setModel] = React.useState(() => localStorage.getItem(MODEL_KEY) ?? "");

  // Once providers load, choose an initial usable provider only when there is no
  // saved selection. A removed or unavailable provider must remain explicit so a
  // later chat cannot unexpectedly go to a hosted connection.
  React.useEffect(() => {
    if (!providers?.length) return;
    if (providerId || model) return;
    const usable = providers.filter(isUsable);
    const first = usable[0];
    if (first) {
      const nextModel =
        first.defaultModel && first.models.includes(first.defaultModel)
          ? first.defaultModel
          : first.models[0];
      setProviderId(first.id);
      setModel(nextModel);
      persistModelSelection(first.id, nextModel);
    }
  }, [providers, providerId, model]);

  const select = React.useCallback((pid: string, m: string) => {
    setProviderId(pid);
    setModel(m);
    persistModelSelection(pid, m);
  }, []);

  return { providerId, model, select };
}
