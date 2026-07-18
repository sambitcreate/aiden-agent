// App-wide provider+model selection, persisted in localStorage (UI preference,
// not routed state). Falls back to the first usable provider once data loads.

import * as React from "react";
import { isUsable } from "../components/model-picker";
import type { Provider } from "./types";

const PROVIDER_KEY = "aiden-agent.providerId";
const MODEL_KEY = "aiden-agent.model";

export function useModelSelection(providers: Provider[] | undefined) {
  const [providerId, setProviderId] = React.useState(() => localStorage.getItem(PROVIDER_KEY) ?? "");
  const [model, setModel] = React.useState(() => localStorage.getItem(MODEL_KEY) ?? "");

  // Once providers load, ensure the selection points at a usable provider/model.
  React.useEffect(() => {
    if (!providers?.length) return;
    const usable = providers.filter(isUsable);
    const current = usable.find((p) => p.id === providerId);
    const modelValid = current?.models.includes(model);
    if (!current || !modelValid) {
      const first = usable[0];
      if (first) {
        const nextModel = first.defaultModel && first.models.includes(first.defaultModel) ? first.defaultModel : first.models[0];
        setProviderId(first.id);
        setModel(nextModel);
        localStorage.setItem(PROVIDER_KEY, first.id);
        localStorage.setItem(MODEL_KEY, nextModel);
      }
    }
  }, [providers, providerId, model]);

  const select = React.useCallback((pid: string, m: string) => {
    setProviderId(pid);
    setModel(m);
    localStorage.setItem(PROVIDER_KEY, pid);
    localStorage.setItem(MODEL_KEY, m);
  }, []);

  return { providerId, model, select };
}
