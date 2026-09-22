import * as React from "react";
import { APPEARANCE_CHANGE_EVENT, readCachedAppearance } from "./appearance-runtime";
import { createDefaultAppearanceConfig, type AppearanceConfig } from "../shared/appearance";

/** Follow the same persisted and live-preview appearance state as the app shell. */
export function useWorkspacePathPreferences() {
  const [config, setConfig] = React.useState(
    () => readCachedAppearance() ?? createDefaultAppearanceConfig(),
  );
  React.useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ config: AppearanceConfig }>).detail;
      setConfig(detail?.config ?? readCachedAppearance() ?? createDefaultAppearanceConfig());
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    update(new Event("refresh"));
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return config;
}
